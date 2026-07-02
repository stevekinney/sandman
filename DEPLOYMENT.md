# Deployment

This is the operator checklist for Sandman's first production deploy. The
command-level runbook lives in `documentation/deployment/containers.md`.

Sandman deploys as one public Fly.io Node server:

- `sandman`: SvelteKit UI, API routes, E2B sandbox provisioning, and same-origin
  Temporal UI proxy.

## Accounts And Artifacts

Prepare these before the first deploy:

- A Fly organization that can create the `sandman` app.
- A Neon Postgres project for demo sessions, sandbox ownership, and rate limits.
- An E2B account and API key.
- A prebuilt E2B template created from `e2b.Dockerfile`.
- A shared invite code stored outside the repository. The UI calls this the
  demo token.

## Secrets

Generate a cookie signing secret:

```sh
openssl rand -hex 32 # SANDMAN_SESSION_SECRET
```

Generate an invite code, store the raw value in a password manager, and
configure only the SHA-256 hash:

```sh
openssl rand -base64 24 # raw invite code
printf '%s' '<raw-invite-code>' | shasum -a 256 | awk '{print $1}'
```

Share the raw invite code only through the password manager. Put the hash in
`SANDMAN_DEMO_TOKEN_SHA256`.

Required Fly secrets:

- `DATABASE_URL`: pooled Neon runtime connection string.
- `E2B_API_KEY`: E2B API key.
- `E2B_TEMPLATE_ID`: prebuilt E2B template ID.
- `SANDMAN_DEMO_TOKEN_SHA256`: SHA-256 hash of the shared invite code.
- `SANDMAN_SESSION_SECRET`: signing secret for the HttpOnly session cookie.

Do not set `MIGRATION_DATABASE_URL` as a Fly runtime secret. Use it only when
running migrations.

Required GitHub `production` environment secrets:

- `FLY_API_TOKEN`: Fly deploy token.
- `MIGRATION_DATABASE_URL`: direct Neon migration connection string.
- `E2B_API_KEY`: E2B API key for template lookup and optional publishing.

Required GitHub `production` environment variables:

- `FLY_ORG`: Fly organization slug. Use `personal` unless a Lost Gradient Fly
  organization exists in `flyctl orgs list`.
- `PRODUCTION_WEB_ORIGIN`: `https://sandman.fly.dev`.
- `E2B_TEAM_ID`: optional E2B team ID.

## Invite Code Rotation

Rotating `SANDMAN_DEMO_TOKEN_SHA256` changes future token exchanges. It does not
automatically remove signed browser sessions that already exchanged the old
invite code. To force old sessions out, revoke rows for the previous hash:

```sql
update demo_session
set status = 'revoked'
where token_hash = '<old-sha256-hash>'
  and status = 'active';
```

Then set the new hash:

```sh
flyctl secrets set -a sandman SANDMAN_DEMO_TOKEN_SHA256="<new-sha256-hash>"
```

Re-run `bun run deploy:status` after rotation. It should report
`SANDMAN_DEMO_TOKEN_SHA256` as present without printing the value.

## E2B Template

Production requires a prebuilt E2B template. Use an E2B API key that is valid
for the account or team that owns Sandman.

Create the template if it does not exist:

```sh
bun e2b template create sandman --path . --dockerfile e2b.Dockerfile
```

Publish updates after changing `e2b.Dockerfile` or sandbox dependencies:

```sh
bun e2b template publish sandman --yes
```

If the template belongs to a team, pass the configured team ID when publishing
or listing:

```sh
bun e2b template publish sandman --yes --team "<team-id>"
bun e2b template list --team "<team-id>" --format json
```

Set the resulting template ID in Fly:

```sh
flyctl secrets set -a sandman E2B_TEMPLATE_ID="<e2b-template-id>"
```

## Fly Setup

Create the app and set secrets:

```sh
flyctl apps create sandman

flyctl secrets set -a sandman \
  DATABASE_URL="<pooled-neon-runtime-url>" \
  E2B_API_KEY="<e2b-api-key>" \
  E2B_TEMPLATE_ID="<e2b-template-id>" \
  SANDMAN_DEMO_TOKEN_SHA256="<sha256-hash>" \
  SANDMAN_SESSION_SECRET="<64-hex-character-secret>"
```

Sandman intentionally uses Fly autostop:

- `auto_stop_machines = "stop"`
- `auto_start_machines = true`
- `min_machines_running = 0`

If a Machine stops while a sandbox is active, the persisted session state remains
in Neon, but the in-process E2B handle is gone. The UI must surface the session
as unavailable or expired rather than pretending reconnect is guaranteed.

## Preflight

Pushes to `main` run the `CI` workflow first. `Deploy Production` runs only
after `CI` succeeds for the current `main` commit. Operators can also run
`Deploy Production` manually with `workflow_dispatch`.

Run these before deploy:

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

Run migrations with the direct Neon URL:

```sh
MIGRATION_DATABASE_URL="<direct-neon-url>" bun run db:migrate
```

Deploy:

```sh
flyctl deploy . --config deployment/fly/web.toml --dockerfile deployment/containers/web.Dockerfile
```

## Health Gates

After deploy:

```sh
curl -fsS https://sandman.fly.dev/health
```

With production-like secrets available, also run:

```sh
bun run smoke:sandbox
bun run proof:preview
bun run smoke:e2e
```

Do not share the raw invite code in logs, screenshots, committed files, or Fly
configuration.
