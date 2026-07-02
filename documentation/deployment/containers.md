# Container Deployment

This is Sandman's command-level deployment source of truth.

## Source Files

- Container image: `deployment/containers/web.Dockerfile`
- Fly app configuration: `deployment/fly/web.toml`
- Deployment status helper: `scripts/deploy.ts`
- Drizzle schema: `src/lib/server/database/schema.ts`

The Fly configuration contains only non-sensitive defaults. Set runtime secrets
with `flyctl secrets set`.

## Service Contract

| Fly app   | Public | Port | Health path | Machine size     | Scaling rule           |
| --------- | ------ | ---- | ----------- | ---------------- | ---------------------- |
| `sandman` | yes    | 3000 | `/health`   | shared CPU, 1 GB | autostop, zero minimum |

Production v1 is single-app and cost-conscious. Fly may stop the Machine when
idle. Neon stores session and rate-limit state, while live E2B handles remain
process-local.

## Environment Ownership

Runtime Fly secrets:

- `DATABASE_URL`
- `E2B_API_KEY`
- `E2B_TEMPLATE_ID`
- `SANDMAN_DEMO_TOKEN_SHA256`
- `SANDMAN_SESSION_SECRET`

`SANDMAN_DEMO_TOKEN_SHA256` is the SHA-256 hash of the shared invite code. The
landing page calls the raw value the demo token. Do not store the raw invite
code in Fly, GitHub, Neon, source files, or logs.

Runtime non-secret defaults in `deployment/fly/web.toml`:

- `SANDMAN_SESSION_TTL_MS=300000`
- `SANDMAN_MAX_ACTIVE_SANDBOXES=20`
- `SANDMAN_MAX_ACTIVE_SANDBOXES_PER_SESSION=1`
- `SANDMAN_SESSION_CREATIONS_PER_TOKEN_PER_HOUR=5`

Migration-only environment:

- `MIGRATION_DATABASE_URL`

GitHub Actions `production` environment:

- Secrets: `FLY_API_TOKEN`, `MIGRATION_DATABASE_URL`, `E2B_API_KEY`.
- Variables: `FLY_ORG`, `PRODUCTION_WEB_ORIGIN`.
- Optional variable: `E2B_TEAM_ID`.

Pushes to `main` deploy only after the `CI` workflow succeeds for the current
`main` commit. Manual production deploys are available through
`workflow_dispatch`.

## Invite Code Commands

Generate a raw invite code:

```sh
openssl rand -base64 24
```

Store the raw value in a password manager. Hash the exact value without adding
a newline:

```sh
printf '%s' '<raw-invite-code>' | shasum -a 256 | awk '{print $1}'
```

Set or rotate the runtime hash:

```sh
flyctl secrets set -a sandman SANDMAN_DEMO_TOKEN_SHA256="<sha256-hash>"
```

If rotation must invalidate existing browser sessions, revoke rows for the old
hash:

```sql
update demo_session
set status = 'revoked'
where token_hash = '<old-sha256-hash>'
  and status = 'active';
```

Completion signal: future token exchanges require the new invite code, and
`bun run deploy:status` reports `SANDMAN_DEMO_TOKEN_SHA256` as present.

Failure signal: if users with the new invite code still receive `401`, confirm
the hash was generated with `printf '%s'` and not `echo`, which adds a newline
on most shells.

## E2B Template Commands

Create the template if it does not exist:

```sh
bun e2b template create sandman --path . --dockerfile e2b.Dockerfile
```

Publish updates:

```sh
bun e2b template publish sandman --yes
```

For team-owned templates, include the team ID when publishing or listing:

```sh
bun e2b template publish sandman --yes --team "<team-id>"
bun e2b template list --team "<team-id>" --format json
```

Set the resolved template ID in Fly:

```sh
flyctl secrets set -a sandman E2B_TEMPLATE_ID="<e2b-template-id>"
```

## Preflight

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

Completion signal: all commands exit zero.

Failure signal: stop before deploying if any local gate or Fly config validation
fails.

## Deploy Procedure

Run migrations first:

```sh
MIGRATION_DATABASE_URL="<direct-neon-url>" bun run db:migrate
```

Deploy the app:

```sh
flyctl deploy . --config deployment/fly/web.toml --dockerfile deployment/containers/web.Dockerfile
```

## Health Gates

Public health:

```sh
curl -fsS https://sandman.fly.dev/health
```

Live E2B checks:

```sh
bun run smoke:sandbox
bun run proof:preview
bun run smoke:e2e
```

Completion signal: `/health` returns `200`, and the live E2B checks pass with
production-like secrets.

Failure signal: if `/health` returns `503`, inspect the dependency payload and
fix the missing configuration or Neon connectivity before running live E2B
checks.
