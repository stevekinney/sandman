# Sandman

Sandman is a browser-based playground for exploring [Temporal](https://temporal.io) durability guarantees in real time.

When you open Sandman, an ephemeral [E2B](https://e2b.dev) Firecracker MicroVM boots inside your session. That VM runs:

- The Temporal CLI dev server (`temporal server start-dev`) — gRPC on port 7233, Web UI on port 8233
- A Temporal TypeScript worker running a deliberately over-engineered food-ordering workflow

The browser shows three surfaces side by side:

1. **Monaco editor** — edit `order-workflow.ts`, `delivery-workflow.ts`, `definitions.ts`, and `activities.ts` live; saving re-syncs the file into the sandbox and hot-restarts the worker (the Temporal server keeps running, so in-flight workflows survive the restart — this is the durability demo)
2. **Temporal Web UI** — the real Temporal Web UI, reverse-proxied same-origin into an iframe
3. **Control plane** — start a workflow, send signals, run queries and updates, and a "kill worker" chaos button that demonstrates durable recovery

## Getting started

```sh
bun install
cp .env.example .env   # fill in the values
bun run dev
```

## Environment variables

| Variable                 | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `E2B_API_KEY`            | Your E2B API key — get one at https://e2b.dev                            |
| `E2B_TEMPLATE_ID`        | ID of the prebuilt E2B template with Node, the Temporal CLI, and worker dependencies baked in. Required in production. Optional in local development. |
| `DATABASE_URL`           | Pooled Neon Postgres runtime connection string for demo sessions, sandbox ownership, and rate limits. |
| `MIGRATION_DATABASE_URL` | Direct Neon Postgres connection string for `bun run db:migrate`; do not set as a Fly runtime secret. |
| `SANDMAN_DEMO_TOKEN_SHA256` | SHA-256 hash of the shared invite code, shown in the UI as the demo token. Store the raw code outside the repo. |
| `SANDMAN_SESSION_SECRET` | Signing secret for the HttpOnly demo session cookie. |
| `SANDMAN_SESSION_TTL_MS` | Sandbox lifetime in milliseconds (default: `300000` / 5 min)             |
| `SANDMAN_MAX_ACTIVE_SANDBOXES` | Global active sandbox limit (default: `20`) |
| `SANDMAN_MAX_ACTIVE_SANDBOXES_PER_SESSION` | Active sandbox limit per browser session (default: `1`) |
| `SANDMAN_SESSION_CREATIONS_PER_TOKEN_PER_HOUR` | Hourly sandbox creation limit per invite code hash (default: `5`) |

## Invite Codes

Sandman uses one shared invite code for production v1. The landing page labels
this value as the demo token. The raw invite code is never stored in source,
Fly configuration, GitHub Actions, or Neon. Sandman stores only a SHA-256 hash
in `SANDMAN_DEMO_TOKEN_SHA256` and compares submitted tokens server-side.

Generate a new invite code:

```sh
openssl rand -base64 24
```

Store the raw output in a password manager, then hash it without a trailing
newline:

```sh
printf '%s' '<raw-invite-code>' | shasum -a 256 | awk '{print $1}'
```

Use that hash as the runtime secret:

```sh
flyctl secrets set -a sandman SANDMAN_DEMO_TOKEN_SHA256="<sha256-hash>"
```

For local development, put the same hash in `.env`:

```sh
SANDMAN_DEMO_TOKEN_SHA256=<sha256-hash>
```

Rotating the invite code only changes future token exchanges. Existing browser
sessions have signed cookies and durable `demo_session` rows. To revoke sessions
created from an old invite code, run this against the production database:

```sql
update demo_session
set status = 'revoked'
where token_hash = '<old-sha256-hash>'
  and status = 'active';
```

## Prebuilt E2B Template

The default flow installs the Temporal CLI and worker npm dependencies on every
boot — a per-boot network dependency. Baking them into a prebuilt E2B template
removes those installs, which makes bootstrap more reliable (and usually faster,
though boot time is network-variable, so treat reliability as the main win).

**Requirements:** `e2b` CLI and an authenticated E2B account with a valid
`E2B_API_KEY`.

Create the template definition from the repo root:

```sh
bunx e2b template create sandman --path . --dockerfile e2b.Dockerfile
```

If the template already exists and you changed `e2b.Dockerfile`, publish the
updated template:

```sh
bunx e2b template publish sandman --yes
```

If Sandman belongs to an E2B team, pass the team ID from `e2b.toml` when
listing or publishing:

```sh
bunx e2b template publish sandman --yes --team "<team-id>"
```

List templates and copy the `sandman` template ID:

```sh
bunx e2b template list --format json
```

Add the ID to `.env` locally and to Fly for production:

```sh
E2B_TEMPLATE_ID=<template-id>
flyctl secrets set -a sandman E2B_TEMPLATE_ID="<template-id>"
```

Sandman reads `E2B_TEMPLATE_ID` at startup. When set, it passes the template ID
to `Sandbox.create()` so each session boots from the prebuilt image. When unset,
it falls back to the default base image with on-demand install—no other config
change required.

`E2B_TEMPLATE_ID` is optional for local development but required when
`NODE_ENV=production`.

The template definition lives in `e2b.Dockerfile` at the repo root. Re-run
`e2b template publish` after updating Node, the Temporal CLI version, or the
worker's `package.json` dependencies to keep the baked cache current.

## Verification gates

Run these in order to confirm the project is healthy:

```sh
bun run format:check   # prettier formatting check
bun run lint           # eslint
bun run check          # svelte-check + TypeScript
bun run build          # vite production build
bun run test           # vitest (unit + browser component)
bun run test:workflows # vitest over sandbox-template/ (food-ordering workflow suite, @temporalio/testing time-skipping)
bun run test:e2e       # Playwright end-to-end
```

### Live integration checks (require `E2B_API_KEY`)

These boot real E2B MicroVMs and exercise the live sandbox path. Each skips cleanly
and exits 0 when `E2B_API_KEY` is unset, and always terminates its sandbox:

```sh
bun run smoke:sandbox  # provision → bootstrap → `temporal workflow list` → preview URL → terminate
bun run proof:preview  # prove the proxy injects the access token upstream and never leaks it to the browser
bun run smoke:e2e      # start an order → worker executes it → kill + restart the worker → cancel → assert the in-flight workflow survives and reaches REFUNDED
```

`smoke:e2e` is the durable-recovery proof, end to end. Typical boot times: ~13s for
`smoke:sandbox`, ~50s for `smoke:e2e`.

## Building & deploying

```sh
bun run build         # vite build → standalone Node server in build/ (via @sveltejs/adapter-node)
node build/index.js   # run it; provide the same env vars (E2B_API_KEY, …)
```

Sandman uses `@sveltejs/adapter-node` (pinned to the SvelteKit 3 `next` line to match
`@sveltejs/kit`). It must be deployed as a Node **server**, not a static site — the
`E2B_API_KEY` stays server-side and the reverse-proxy routes run on the server.

Production deployment uses Fly.io and Neon. See `DEPLOYMENT.md` for the setup
checklist and `documentation/deployment/containers.md` for the command-level
runbook.

## Demo Script

Sandman demonstrates the following Temporal features through a deliberately over-engineered food-ordering workflow.

### Feature Legend

| Feature | Concept | How it is demonstrated |
| ------- | ------- | ---------------------- |
| activities-retry | **Activities & Automatic Retry** (`start-order`) | Payment charge, restaurant notification, and courier dispatch each run as activities with configurable retry policies. Transient failures are automatically retried with exponential backoff. |
| non-retryable-failure | **Non-Retryable Failures** (`start-order`) | An invalid payment method or out-of-area address throws ApplicationFailure with nonRetryable: true, bypassing the retry policy and immediately triggering the saga compensation path. |
| saga-compensation | **Saga / Compensation** (`cancel-order`) | If the workflow fails after charging the customer, a compensation stack issues a refund. Each forward step registers a compensating action so the rollback is always symmetric. |
| signals | **Signals** (`accept-restaurant`) | Restaurant acceptance, rejection, food-ready, courier location, tip, and order cancellation all use Temporal signals. The workflow blocks on signal receipt using condition(), resuming only when the expected signal arrives. |
| queries | **Queries** (`query-status`) | getStatus returns a live OrderSnapshot of all workflow state without advancing execution. getTimeline returns the annotated event log consumed by the guided-tour panel. |
| updates-validators | **Updates with Validators** (`update-address`) | updateDeliveryAddress is rejected synchronously by a validator if the order is already in delivery. applyPromoCode validates the code before mutating state, returning a typed rejection to the caller without re-driving the workflow. |
| timers-durable-sleep | **Durable Timers / sleep()** (`start-order`) | A configurable deadline timer fires if the restaurant does not accept within N minutes, automatically triggering cancellation and saga compensation. The timer survives worker restarts. |
| child-workflow | **Child Workflows** (`food-ready`) | Once a courier is assigned, the delivery leg is handed off to a DeliveryWorkflow child workflow. Its lifecycle is independently visible in the Temporal Web UI, demonstrating workflow composition. |
| heartbeats-cancellation | **Activity Heartbeats & Cancellation** (`kill-worker`) | The courier-tracking activity heartbeats every 5 seconds with its latest location. Cancelling the order propagates cancellation to the activity via the heartbeat token, allowing a clean shutdown. |
| continue-as-new | **ContinueAsNew** (—) | After 100 courier location updates, the workflow calls continueAsNew to keep event history bounded. The new run receives the current OrderSnapshot as its seed state so no data is lost. |
| queryable-business-snapshot | **Queryable Business Snapshot** (`query-status`) | getStatus returns OrderStatus, CustomerTier, and RestaurantId in businessSnapshot. This gives learners a simple read model before the advanced Search Attributes scenario. |
| search-attributes | **Temporal Search Attributes** (`list-visibility`) | The advanced Visibility scenario upserts OrderStatus, CustomerTier, and RestaurantId as real Temporal Search Attributes and lists matching executions through Temporal Visibility. |
| local-activities | **Local Activities** (`start-order`) | Audit-log writes and metrics emission run as local activities (executed in the same process, no round-trip to the Temporal server) to demonstrate the durability/performance trade-off. |
| replay-safety | **Replay Safety** (—) | All non-deterministic operations (random IDs, current time, external HTTP calls) are wrapped in activities. The workflow function itself is a pure deterministic function of its history, as verified by the replayer. |
| durable-recovery | **Durable Recovery** (`kill-worker`) | The kill-worker button terminates the Node.js worker process mid-flight. Because the Temporal server preserves all workflow state, the workflow resumes exactly where it left off when the worker restarts — the centrepiece of the Sandman demo. |

### Guided Tour

The tour advances step-by-step as real Temporal workflow events arrive — not on button clicks.

1. **Place a food order** (control: `start-order`)
   Start one durable order workflow. Temporal records the start event in history, then a worker begins running your workflow code.

2. **Activities run — with automatic retries**
   Payment charge, restaurant notification, and courier dispatch each run as activities. If a transient failure occurs, Temporal retries automatically with exponential backoff. You do not write retry loops.

3. **A durable timer guards the deadline**
   The workflow starts a timer for the restaurant-acceptance deadline. This timer lives in the Temporal server — it will fire even if the worker crashes and restarts.

4. **Send a signal to resume** (control: `accept-restaurant`)
   The order is parked waiting for the restaurant. Sending the restaurant-accepted signal appends an event to history and resumes the workflow.

5. **Update with a synchronous validator** (control: `update-address`)
   Update the delivery address while the order is preparing. A validator accepts or rejects the change before any workflow state mutates — bad changes are rejected immediately.

6. **Hand delivery to a child workflow** (control: `food-ready`)
   Food ready spawns a DeliveryWorkflow child. The parent keeps owning the order, while the delivery workflow can be tracked on its own in the Temporal UI.

7. **Read state with a query** (control: `query-status`)
   Ask the running workflow for its current order snapshot. Queries are read-only: they inspect state without moving the workflow forward.

8. **Search across workflows** (control: `list-visibility`)
   List executions by indexed Search Attributes — order status, customer tier, and restaurant — across every workflow, no specific handle needed.

9. **Kill the worker — watch it recover** (control: `kill-worker`)
   Kill the process running your workflow code. State lives in the Temporal server, so after you restart the worker it replays history and resumes exactly where it left off.

10. **Finish the delivery** (control: `complete-delivery`)
   Complete the child delivery workflow. The parent observes that result and moves the order to its delivered final state.
