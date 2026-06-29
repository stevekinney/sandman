# Sandman

Sandman is a browser-based playground for exploring [Temporal](https://temporal.io) durability guarantees in real time.

When you open Sandman, an ephemeral [E2B](https://e2b.dev) Firecracker MicroVM boots inside your session. That VM runs:

- The Temporal CLI dev server (`temporal server start-dev`) — gRPC on port 7233, Web UI on port 8233
- A Temporal TypeScript worker running a deliberately over-engineered food-ordering workflow

The browser shows three surfaces side by side:

1. **Monaco editor** — edit `workflows.ts` and `activities.ts` live; saving re-syncs the file into the sandbox and hot-restarts the worker (the Temporal server keeps running, so in-flight workflows survive the restart — this is the durability demo)
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
| `E2B_TEMPLATE_ID`        | _Optional._ ID of a prebuilt E2B template with Node + the Temporal CLI + worker deps baked in. If unset, Sandman uses the default base image and installs the Temporal CLI and worker dependencies on demand during bootstrap. |
| `SANDMAN_SESSION_TTL_MS` | Sandbox lifetime in milliseconds (default: `300000` / 5 min)             |

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
| search-attributes | **Search Attributes** (`query-status`) | Order status, customer tier, and restaurant ID are upserted as typed search attributes on every status transition, enabling Temporal list queries (e.g. "all PREPARING orders for restaurant X"). |
| local-activities | **Local Activities** (`start-order`) | Audit-log writes and metrics emission run as local activities (executed in the same process, no round-trip to the Temporal server) to demonstrate the durability/performance trade-off. |
| replay-safety | **Replay Safety** (—) | All non-deterministic operations (random IDs, current time, external HTTP calls) are wrapped in activities. The workflow function itself is a pure deterministic function of its history, as verified by the replayer. |
| durable-recovery | **Durable Recovery** (`kill-worker`) | The kill-worker button terminates the Node.js worker process mid-flight. Because the Temporal server preserves all workflow state, the workflow resumes exactly where it left off when the worker restarts — the centrepiece of the Sandman demo. |

### Guided Tour

The tour advances step-by-step as real Temporal workflow events arrive — not on button clicks.

1. **Place a food order** (control: `start-order`)
   Click "Start Order" to kick off the food-ordering workflow. A WorkflowExecution is created in the Temporal server and your workflow function begins running inside the worker process.

2. **Activities run — watch automatic retry** (control: `start-order`)
   Payment charge, restaurant notification, and courier dispatch each run as activities. If a transient failure occurs, Temporal retries automatically with exponential backoff. You do not write retry loops.

3. **A durable timer guards the restaurant deadline** (control: `start-order`)
   The workflow starts a timer for the restaurant-acceptance deadline. This timer lives in the Temporal server — it will fire even if the worker crashes and restarts.

4. **Send a signal to resume the workflow** (control: `accept-restaurant`)
   Click "Accept" to send a restaurantAccepted signal. The workflow has been blocking on condition() waiting for this signal. It now resumes and transitions to the Preparing state.

5. **A child workflow handles delivery** (control: `food-ready`)
   Once the food is ready, the delivery leg is handed off to a DeliveryWorkflow child. You can see it listed independently in the Temporal Web UI, demonstrating workflow composition.

6. **Updates with synchronous validators** (control: `update-address`)
   Try updating the delivery address. The validator runs synchronously before the handler — if the order is already in delivery the update is rejected instantly, with no workflow execution consumed.

7. **Search attributes make workflows queryable** (control: `query-status`)
   Every status transition upserts typed search attributes (OrderStatus, CustomerTier, RestaurantId). Open the Temporal Web UI to run a list query like "all PREPARING orders for this restaurant".

8. **ContinueAsNew keeps event history bounded** (control: `update-location`)
   After 100 courier location updates the workflow calls continueAsNew, starting a fresh run with the current state. The new run appears as a continuation in the Temporal Web UI.

9. **Kill the worker — watch it recover** (control: `kill-worker`)
   Click "Kill Worker" to terminate the Node.js process mid-flight. The Temporal server has preserved all workflow state. Restart the worker and watch the workflow resume exactly where it left off — this is the centrepiece of the Sandman demo.
