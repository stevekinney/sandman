---
name: sandman-production-operations
description: Ship Sandman to production and triage deployment, health-check, Fly.io, Neon, E2B template, demo-token access, sandbox lifecycle, rate-limit, reaper, or live smoke-test issues. Use when a user asks to deploy Sandman, prepare production secrets, verify production readiness, debug a broken Sandman deploy, inspect production health, recover a failed sandbox rollout, or validate cost/concurrency controls.
---

# Sandman Production Operations

## Overview

Operate Sandman production from the repository runbooks. Treat `DEPLOYMENT.md`
as the setup checklist and `documentation/deployment/containers.md` as the
command-level source of truth for deploy, health, rollback, and smoke checks.

## Start Here

1. Read `DEPLOYMENT.md` and `documentation/deployment/containers.md` before
   changing production state.
2. Check local state without printing secrets:
   `git status --short --branch`, `bun run deploy:status`,
   `flyctl auth whoami`, and `flyctl status --app sandman`.
3. Classify the task:
   - **First deploy/readiness**: validate configuration, create the Fly app, set
     secrets, migrate, deploy, and run health/smoke gates.
   - **Triage**: identify the failing layer before changing anything.
   - **Rollback/recover**: use Fly releases or Machines state, then verify the
     full health gate afterward.
   - **Cost/concurrency review**: verify autostop, TTL cleanup, rate limits, and
     global active sandbox counts.

## Production Invariants

- Sandman has one public Fly app: `sandman`.
- Fly serves the SvelteKit Node app on `PORT=3000`.
- Production v1 intentionally uses Fly autostop:
  `auto_stop_machines = "stop"`, `auto_start_machines = true`, and
  `min_machines_running = 0`.
- Runtime state lives in Neon. Live E2B handles are process-local and are not
  guaranteed to survive Fly Machine stop/start.
- `DATABASE_URL` is the pooled Neon runtime URL and belongs on Fly.
- `MIGRATION_DATABASE_URL` is direct/unpooled and is only for migrations; never
  set it as a Fly runtime secret.
- `E2B_TEMPLATE_ID` is mandatory for production. Do not rely on development
  on-demand installs in production.
- The raw demo token must never be committed, logged, pasted into docs, or set
  as a Fly secret. Store only `SANDMAN_DEMO_TOKEN_SHA256`.
- `SANDMAN_SESSION_SECRET` signs the HttpOnly browser session cookie.
- Default controls are one active sandbox per browser session, five sandbox
  creations per token per hour, twenty global active sandboxes, and a
  five-minute sandbox TTL.

## First Deploy Workflow

Use installed CLIs where possible before asking the user to do manual console
work. Do not print secret values.

1. Verify tooling and authentication: `bun`, `flyctl`, `neonctl`, and Docker if
   building containers locally.
2. Validate local release readiness:
   ```sh
   bun run format:check
   bun run lint
   bun run check
   bun run build
   bun run test
   bun run test:workflows
   bun run test:e2e
   bun run docs:demo:check
   bun run deploy:status
   flyctl config validate --config deployment/fly/web.toml
   ```
3. Create or verify the Fly app:
   ```sh
   flyctl apps create sandman
   ```
4. Prepare Neon:
   - Use the pooled runtime connection string for `DATABASE_URL`.
   - Use the direct connection string for `MIGRATION_DATABASE_URL`.
   - Run migrations locally or in the deploy workflow with the direct URL:
     ```sh
     MIGRATION_DATABASE_URL="<direct-neon-url>" bun run db:migrate
     ```
5. Prepare E2B:
   - Verify `E2B_API_KEY` exists.
   - Verify the prebuilt template exists and record its ID as `E2B_TEMPLATE_ID`.
6. Generate access secrets without exposing values:
   ```sh
   openssl rand -hex 32 # SANDMAN_SESSION_SECRET
   printf '%s' '<raw-demo-token>' | shasum -a 256
   ```
7. Set Fly secrets:
   ```sh
   flyctl secrets set -a sandman \
     DATABASE_URL="<pooled-neon-runtime-url>" \
     E2B_API_KEY="<e2b-api-key>" \
     E2B_TEMPLATE_ID="<e2b-template-id>" \
     SANDMAN_DEMO_TOKEN_SHA256="<sha256-hash>" \
     SANDMAN_SESSION_SECRET="<64-hex-character-secret>"
   ```
8. Deploy:
   ```sh
   flyctl deploy . --config deployment/fly/web.toml --dockerfile deployment/containers/web.Dockerfile
   ```

## Health And Smoke Gates

Run these after deploy and after any rollback:

```sh
bun run deploy:status
curl -fsS https://sandman.fly.dev/health
```

With production-like secrets available, also run:

```sh
bun run smoke:sandbox
bun run proof:preview
bun run smoke:e2e
```

Completion signal: `/health` returns `200`, live E2B checks pass, and
`bun run deploy:status` reports the app and required Fly secrets as present.

Failure signal: if `/health` returns `503`, inspect the dependency payload and
fix missing configuration or Neon connectivity before running live E2B checks.

## Triage Workflow

Start with evidence, not changes:

1. Run `bun run deploy:status` and capture whether the app, secrets, Fly auth,
   or local configuration are missing.
2. Check Fly state and logs:
   ```sh
   flyctl status --app sandman
   flyctl logs --app sandman
   flyctl machines list --app sandman
   ```
3. Map the symptom to a layer:
   - **Health returns 503**: check `DATABASE_URL`, `E2B_API_KEY`,
     `E2B_TEMPLATE_ID`, `SANDMAN_DEMO_TOKEN_SHA256`,
     `SANDMAN_SESSION_SECRET`, and Neon `SELECT 1` connectivity.
   - **Demo token rejected**: verify the user entered the raw token and Fly has
     only the SHA-256 hash. Recompute with `printf '%s'` to avoid a trailing
     newline.
   - **Session cookie missing or invalid**: check `SANDMAN_SESSION_SECRET`,
     HTTPS access, cookie attributes, browser origin, and session TTL.
   - **Mutating requests fail authorization**: verify `Origin` and `Host`
     match. Do not loosen origin checks to make cross-site requests work.
   - **Sandbox creation returns 429**: check per-session active sandbox count,
     token hourly creation bucket, and global active sandbox count.
   - **Sandbox creation returns 503**: check global capacity, E2B API key,
     template ID, and provision/bootstrap logs.
   - **UI remains stuck after provisioning**: check `sandbox_session.status`
     for `bootstrapping` or `error`, then inspect structured bootstrap logs.
   - **Expired sandboxes linger**: check TTL settings, reaper logs, E2B
     termination failures, and whether the process stayed alive long enough for
     the interval to run.
   - **Fly restart loses live handle**: treat it as expected for production v1.
     Neon can identify the session, but process-local E2B handles may be gone;
     surface the sandbox as unavailable, expired, or terminated.
   - **Unexpected cost/concurrency growth**: inspect `/api/monitoring` through
     an authenticated browser session, global active count, recent bootstrap
     failures, and expired-session cleanup counts.
4. Fix the smallest failing layer and rerun the health/smoke gates.

Stop and report a blocker instead of guessing when the missing information is a
secret, provider-console setting, destructive database action, or production
change the user has not explicitly authorized.

## Rollback And Recovery

Prefer reversible Fly operations and verify afterward:

1. Inspect releases:
   ```sh
   flyctl releases --app sandman
   ```
2. Roll back only with explicit user approval:
   ```sh
   flyctl releases rollback <version> --app sandman
   ```
3. Re-run:
   ```sh
   bun run deploy:status
   curl -fsS https://sandman.fly.dev/health
   ```
4. If a rollback lands on code with a different schema expectation, stop before
   changing database state and ask for approval with the exact risk.

## External Console Checklist

When CLI/API access cannot update provider settings, give the user a concise
checklist and ask only for statuses, not secrets:

- Fly app `sandman` exists in the intended organization.
- Fly secrets include `DATABASE_URL`, `E2B_API_KEY`, `E2B_TEMPLATE_ID`,
  `SANDMAN_DEMO_TOKEN_SHA256`, and `SANDMAN_SESSION_SECRET`.
- Neon runtime URL is pooled and migration URL is direct/unpooled.
- Drizzle migrations have run against the direct Neon URL.
- E2B template exists and matches the current sandbox template.
- The raw demo token is stored externally and only its SHA-256 hash is
  configured in Fly.
- `/health` returns `200` from `https://sandman.fly.dev/health`.
- Live smoke checks pass with production-like secrets.
