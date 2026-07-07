# sandbox-template

This directory contains the Node.js / TypeScript code that runs **inside** the E2B Firecracker MicroVM. The Temporal dev server (`temporal server start-dev`) runs on the same VM; this code connects to it on `localhost:7233`.

It is also the code you see (and edit) in the Sandman Monaco editor, so it is written to be read top to bottom by someone who has never seen Temporal before.

## The example: a food order

One workflow, four steps:

1. **Charge the card**: an activity. If it fails transiently, Temporal retries it automatically.
2. **Wait for the restaurant**: the workflow parks on a signal, guarded by a durable timer. If the restaurant never accepts, the timer fires and the payment is refunded.
3. **Wait for delivery**: another signal. This wait can last hours and survives worker crashes.
4. **Done**: the workflow returns its final state.

Along the way you can query the live state (`getStatus`), cancel the order (`cancelOrder` triggers a refund), and—the centrepiece—kill the worker mid-flight and watch the workflow resume exactly where it left off.

## Read the files in this order

| File | What it teaches |
| ---- | --------------- |
| `workflow.ts` | **Start here.** The entire workflow: signal and query definitions, the activity proxy with its retry policy, and the four-step order function. Every `await` in it is durable. |
| `activities.ts` | The side effects: `chargePayment` (with two magic card numbers—`'0000'` fails once to demo retries, `'9999'` is declined to demo non-retryable failures), `notifyRestaurant`, and `refundPayment`. |
| `shared.ts` | The plain types and constants both sides share: `OrderInput`, `OrderSnapshot`, statuses, the task queue name. Nothing Temporal-specific. |
| `worker.ts` | The process that runs your code: connects to the server, registers the workflow and activities, polls the task queue. |
| `client.ts` | A CLI demo driver: start an order, query it, signal it forward, await the result. |

Look for `Try:` comments in `workflow.ts` and `activities.ts`—each marks a one-line edit that produces visibly different behavior. Saving a file in the editor hot-restarts the worker while the Temporal server (and every in-flight workflow) keeps running.

## Which button exercises which feature

| Control-plane button | Temporal feature | How it works in the workflow |
| -------------------- | ---------------- | ---------------------------- |
| **Place order** | Activities + retry | `chargePayment` retries with exponential backoff; card `'0000'` fails its first attempt on purpose |
| **Place order** (card `'9999'`) | Non-retryable failure | `ApplicationFailure.nonRetryable(..., 'PaymentDeclined')` skips the retry policy; the workflow cancels the order |
| **Place order** | Durable timers | `condition(..., timeout)` guards the restaurant wait; if it fires, the workflow refunds the payment |
| **Restaurant accepted** | Signals | The `restaurantAccepted` signal unblocks the first `condition()` |
| **Complete delivery** | Signals | The `deliveryCompleted` signal unblocks the final wait and the workflow returns |
| **Cancel & refund** | Signals | The `cancelOrder` signal makes the workflow refund the charge and finish as cancelled |
| **Get status** | Queries | `getStatus` returns the live `OrderSnapshot`—read-only, no history written |
| **Kill worker** | Durable recovery | Terminating the worker process leaves in-flight workflows intact on the server; restarting replays history and resumes exactly where it left off |

## Running it locally

Start the Temporal dev server (bundled with the [Temporal CLI](https://docs.temporal.io/cli)):

```sh
temporal server start-dev
```

Start the worker in a second terminal:

```sh
bun run sandbox-template/worker.ts
```

Drive one order through its whole life from a third:

```sh
bun run sandbox-template/client.ts
```

Then open http://localhost:8233 to inspect the execution in the Temporal Web UI.

## Running tests

```sh
bun run test:workflows
```

`workflow.test.ts` exercises the workflow against a real (time-skipping) Temporal test server via `@temporalio/testing`. The test server binary is downloaded on first run by the Temporal SDK.

## How this runs inside the E2B sandbox

Sandman's sandbox service (`src/lib/server/sandbox/`) boots a fresh MicroVM and:

1. Copies every `.ts`/`.json` file in this directory (except tests and vitest config) into the VM's `/app`.
2. Ensures the Temporal CLI is present—the E2B base image ships Node but **not** the Temporal CLI, so it is installed on demand (download + symlink onto `PATH`), or baked into a prebuilt template.
3. Runs `npm install` in `/app` against this `package.json`.
4. Starts `temporal server start-dev`, then the worker (`tsx worker.ts`), as separate supervised processes. The server keeps running across worker restarts—this is what makes the kill-worker durable-recovery demo work.

This whole flow is exercised against real E2B by `bun run smoke:sandbox` and `bun run smoke:e2e` (see the root README).

### `package.json`

Declares the worker's runtime dependencies—`@temporalio/{worker,workflow,activity,client,common}` and `tsx`—pinned to the same versions as the host app so workflow behavior and replay stay consistent. The bootstrap copies this file into the sandbox at `/app` and runs `npm install`; without it the worker has no dependencies and never starts.

### Contract mirror

`shared.ts` is a standalone mirror of the workflow-facing half of `src/lib/contracts/workflow-api.ts`. It ships into the VM where `src/lib/` is absent, so it must not import from the app layer. If you change one, keep the other in sync—`src/lib/contracts/contracts.spec.ts` asserts they cannot drift.
