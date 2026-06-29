# sandbox-template

This directory contains the Node.js / TypeScript code that runs **inside** the E2B Firecracker MicroVM. The Temporal dev server (`temporal server start-dev`) runs on the same VM; this code connects to it on `localhost:7233`.

## Files

### `shared.ts`

Standalone mirror of `src/lib/contracts/workflow-api.ts`. Contains all types, constants (`ORDER_STATUS`, `CUSTOMER_TIER`, `TASK_QUEUE`, workflow type names), and `PROMO_CODES`. Does **not** import from the SvelteKit app layer so it works inside the VM where `src/lib/` is absent.

### `activities.ts`

All Temporal activity implementations.

| Activity           | Type                | Purpose                                                            |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `validateOrder`    | local               | Validates item list, address, payment method                       |
| `calculatePricing` | local               | Computes subtotal, delivery fee, promo discount                    |
| `writeAuditLog`    | local               | Structured audit log entry                                         |
| `emitMetrics`      | local               | Phase-transition metrics                                           |
| `chargePayment`    | regular             | Charges the customer; non-retryable on `PAYMENT_DECLINED`          |
| `refundPayment`    | regular             | Saga compensation — refunds the customer                           |
| `notifyRestaurant` | regular             | Sends order to restaurant POS                                      |
| `assignCourier`    | regular             | Allocates a courier and returns `CourierInfo`                      |
| `releaseCourier`   | regular             | Saga compensation — returns courier to pool                        |
| `dispatchCourier`  | regular             | Confirms courier dispatch                                          |
| `trackCourier`     | regular (heartbeat) | Infinite heartbeat loop; throws `CancelledFailure` on cancellation |

### `workflows.ts`

Three exported workflow functions plus signal/query/update definitions.

**`orderFoodWorkflow(input, seed?)`** — the primary orchestration workflow. State machine: `CREATED → VALIDATING → AWAITING_RESTAURANT → PREPARING → AWAITING_COURIER → IN_DELIVERY → DELIVERED`, with `CANCELLED`/`REFUNDED` terminal branches.

**`deliveryWorkflow(input)`** — child workflow for courier lifecycle. Starts `trackCourier` in a cancellable scope and waits for the `deliveryCompleted` signal or a 2-hour SLA.

**`subscriptionWorkflow(input)`** — periodic reorder loop. Calls `continueAsNew` after each cycle to bound event history.

**`timeSkipSanity()`** — test-only; confirms the time-skipping test server is working.

### `worker.ts`

Bootstrap for the Temporal worker. Connects to `localhost:7233`, registers all activities and the workflow bundle, and starts polling.

### `client.ts`

Helper functions for driving the workflow from the CLI demo script. Exports `startOrder`, signal helpers (`acceptRestaurant`, `signalFoodReady`, `signalDeliveryCompleted`, `cancelOrder`, `updateLocation`, `addTip`), update helpers (`updateAddress`, `applyPromo`), query helpers (`queryStatus`, `queryTimeline`), and a `runDemo()` entry point.

### `vitest.config.ts`

Standalone Vitest configuration for this directory. Uses a plain `node` environment (no SvelteKit/Vite stack) so `@temporalio/testing` loads correctly.

### `package.json`

Declares the worker's runtime dependencies — `@temporalio/{worker,workflow,activity,client,common}` and `tsx` — pinned to the same versions as the host app so workflow behavior and replay stay consistent. The bootstrap copies this file into the sandbox at `/app` and runs `npm install`; without it the worker has no dependencies and never starts.

## How this runs inside the E2B sandbox

Sandman's sandbox service (`src/lib/server/sandbox/`) boots a fresh MicroVM and:

1. Copies every `.ts`/`.json` file in this directory into the VM's `/app`.
2. Ensures the Temporal CLI is present — the E2B base image ships Node but **not** the Temporal CLI, so it is installed on demand (download + symlink onto `PATH`), or baked into a prebuilt template.
3. Runs `npm install` in `/app` against this `package.json`.
4. Starts `temporal server start-dev`, then the worker (`tsx worker.ts`), as separate supervised processes. The server keeps running across worker restarts — this is what makes the kill-worker durable-recovery demo work.

This whole flow is exercised against real E2B by `bun run smoke:sandbox` and `bun run smoke:e2e` (see the root README).

## Running the worker (locally)

Start the Temporal dev server first (bundled with the CLI):

```sh
temporal server start-dev
```

Then start the worker in a second terminal:

```sh
bun run sandbox-template/worker.ts
```

The worker prints:

```
[sandman] Worker running on task queue: sandman-food
[sandman] Temporal Web UI: http://localhost:8233
[sandman] Ctrl-C to stop (in-flight workflows survive on the server)
```

## Running the demo script

With both the server and worker running:

```sh
bun run sandbox-template/client.ts
```

This places a sample order, drives it through the full happy path (restaurantAccepted → foodReady → deliveryCompleted), and prints the final status and total.

## Running tests

```sh
bun run test:workflows
```

Tests use `@temporalio/testing`'s `TestWorkflowEnvironment.createTimeSkipping()`. The test server binary is downloaded on first run by the Temporal SDK.

## Demo script: which button exercises which feature

| Control-plane button            | Temporal feature            | How it works in the workflow                                                                                                                               |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start Order**                 | Activities + Retry          | `chargePayment` retries with exponential backoff on transient gateway errors                                                                               |
| **Start Order** (declined card) | Non-Retryable Failure       | `google-pay` triggers `ApplicationFailure(nonRetryable: true, type: 'PAYMENT_DECLINED')`, bypassing retries                                                |
| **Start Order**                 | Local Activities            | `validateOrder` and `calculatePricing` run as local activities (same process, no server round-trip)                                                        |
| **Start Order**                 | Durable Timers              | A configurable `condition(..., Nm)` deadline fires if the restaurant doesn't accept; workflow auto-cancels and refunds                                     |
| **Accept Restaurant**           | Signals                     | `restaurantAccepted` signal unblocks the `condition()` in AWAITING_RESTAURANT phase                                                                        |
| **Reject Restaurant**           | Signals                     | `restaurantRejected` signal triggers immediate cancellation                                                                                                |
| **Food Ready**                  | Signals + Child Workflow    | `foodReady` advances to AWAITING_COURIER; courier assignment starts `deliveryWorkflow` as a child                                                          |
| **Cancel Order**                | Saga Compensation           | Mid-flight cancel triggers `refundPayment` + `releaseCourier` in LIFO order                                                                                |
| **Update Location**             | Heartbeats + ContinueAsNew  | `courierLocationUpdate` signal increments the counter; at 100 updates the workflow calls `continueAsNew`                                                   |
| **Add Tip**                     | Signals                     | `addTip` mutates `tipCents` and `totalCents` in real time                                                                                                  |
| **Update Address**              | Updates + Validators        | Accepted before IN_DELIVERY; the validator rejects the update with `order-already-in-delivery` once delivery starts                                        |
| **Apply Promo**                 | Updates + Validators        | Validates the code synchronously, applies discount, returns new total                                                                                      |
| **Query Status**                | Queries + Search Attributes | `getStatus` returns live `OrderSnapshot`; `searchAttributes` reflects current state                                                                        |
| **Query Timeline**              | Queries + Replay Safety     | `getTimeline` returns annotated event log; same history used by the replay-safety test                                                                     |
| **Kill Worker**                 | Durable Recovery            | Terminating the Node.js worker process mid-flight leaves in-flight workflows intact on the server; restarting the worker resumes exactly where it left off |

## Temporal features exercised

| Feature                      | Mechanism                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activities + automatic retry | `chargePayment` and `notifyRestaurant` use a configurable `RetryPolicy`                                                                                    |
| Non-retryable failure        | `ApplicationFailure.nonRetryable(msg, 'PAYMENT_DECLINED')` bypasses retry                                                                                  |
| Saga / compensation          | A `compensations` stack is built up; `runCompensations()` executes LIFO on any failure path                                                                |
| Signals                      | Six signals (`cancelOrder`, `restaurantAccepted`, `restaurantRejected`, `foodReady`, `courierLocationUpdate`, `addTip`)                                    |
| Queries                      | `getStatus` (full snapshot) and `getTimeline` (annotated event log) are read-only                                                                          |
| Updates with validators      | `updateDeliveryAddress` rejects synchronously after IN_DELIVERY; `applyPromoCode` validates the code before mutating state                                 |
| Durable timers / `sleep()`   | Restaurant-accept deadline via `condition(..., Nm)`; 2-hour delivery SLA in child workflow                                                                 |
| Child workflows              | `deliveryWorkflow` runs as an independent child, visible in the Temporal Web UI                                                                            |
| Heartbeats + cancellation    | `trackCourier` heartbeats every 5 s; cancelling the order propagates via `CancellationScope`; uses `WAIT_CANCELLATION_COMPLETED` so cleanup is synchronous |
| ContinueAsNew                | `subscriptionWorkflow` calls `continueAsNew` each cycle; `orderFoodWorkflow` calls it after 100 location updates                                           |
| Search attributes            | `OrderStatus`, `CustomerTier`, and `RestaurantId` are mirrored in `OrderSnapshot.searchAttributes` on every transition                                     |
| Local activities             | `validateOrder`, `calculatePricing`, `writeAuditLog`, `emitMetrics`                                                                                        |
| Replay safety                | All non-deterministic operations are in activities; the replay test confirms no determinism violations                                                     |
| Durable recovery             | Kill-worker demo proves in-flight state survives worker process termination                                                                                |
