# Follow-ups

Open work items for Sandman. Ordered by priority. Each item lists the concrete
next step and the files involved so it can be picked up cold.

## Validated

### Live E2B path — validated end-to-end (2026-06-29)

The live integration was exercised against real E2B with a provided `E2B_API_KEY`.
`bun run smoke:sandbox`, `bun run proof:preview`, and a new `bun run smoke:e2e` all
pass. Three real bugs that only surface against live E2B were found and fixed:

- **The worker had no dependencies** (the core bug). `sandbox-template/` had no
  `package.json`, so the bootstrap `npm install` installed nothing — the worker
  (`@temporalio/worker`, `tsx`) could never start. The `ready` probe only checks the
  Temporal _server_, so the dead worker was masked. Added `sandbox-template/package.json`
  pinned to the host's `@temporalio/* @ 1.18.1` + `tsx @ 4.22.4`. The worker now
  bundles `workflows.ts` (webpack) and executes orders.
- **The Temporal CLI is absent from the E2B base image.** `bootstrap` threw instead of
  installing it. It now installs on demand (`temporal.download/cli.sh` + symlink onto
  PATH) and re-verifies — see `ensureRuntimeDependencies` in
  `src/lib/server/sandbox/client.ts`, with a regression test in `client.spec.ts`.
- **Workflow type-name mismatch.** The app started `ORDER_FOOD_WORKFLOW =
  'OrderFoodWorkflow'`, but the worker registers by function name `orderFoodWorkflow`,
  so "Start order" would fail with _"workflow type not registered"_. Corrected the
  constant in `src/lib/contracts/workflow-api.ts` and `sandbox-template/shared.ts`.

`smoke:e2e` proves the durability thesis end-to-end: start → worker executes (payment
charged → `AWAITING_RESTAURANT`) → kill + restart the worker → cancel → the in-flight
workflow survives the restart and reaches a terminal `REFUNDED` state. Observed boot
times: ~13s for `smoke:sandbox`, ~50s for the full `smoke:e2e`.

## Medium

### 1. Build a prebuilt E2B template

Bootstrap installs the Temporal CLI and the worker's npm deps on every boot
(~13–50s, network-dependent). Bake Node + the Temporal CLI + the worker deps into a
prebuilt E2B template image and reference it via an `E2B_TEMPLATE_ID` env var to cut
cold-start latency and remove a per-boot network dependency. Keep the install-on-boot
path (`ensureRuntimeDependencies` + `npm install`) as a fallback.

### 2. Make the editor show the real deployed workflow

`src/lib/components/editor/file-descriptors.ts` ships a simplified `OrderFoodWorkflow`
(PascalCase, ~70 lines) as the Monaco default, but the sandbox actually runs
`sandbox-template/workflows.ts` (`orderFoodWorkflow`, ~870 lines). The editor shows
different code than what executes — confusing for a teaching tool. Load/sync the real
template files into the editor so it reflects (and edits) the deployed workflow.

### 3. Configure a production deployment adapter

`bun run build` warns _"Could not detect a supported production environment."_ — the
project still uses `@sveltejs/adapter-auto` (`vite.config.ts`). Sandman needs a server
at runtime (the `E2B_API_KEY` must stay server-side; the proxy/SSE routes are server
routes), so pick a real adapter (likely `adapter-node`), swap it in, and confirm the
built server runs before any deploy.

## Low

### 4. Fix the `TimelineEntry.featureId` contract drift

`sandbox-template/shared.ts` declares `featureId?: string`, but the contract at
`src/lib/contracts/workflow-api.ts` declares `featureId?: FeatureId` (a specific union).
Tighten `shared.ts` to use `FeatureId` so the two agree.

### 5. Remove the Cinder workarounds once upstream fixes land

- **SSR** — `src/routes/[sessionId]/+page.server.ts` sets `export const ssr = false`.
  Re-enable SSR once [stevekinney/cinder#533](https://github.com/stevekinney/cinder/issues/533)
  ships.
- **Dep optimizer** — `vite.config.ts` sets `optimizeDeps.exclude: ['@lostgradient/cinder']`.
  Remove it once [stevekinney/cinder#534](https://github.com/stevekinney/cinder/issues/534)
  ships.

Re-verify all gates after removing each workaround.

### 6. Code-split the 3.6MB Monaco bundle chunk

The production build emits a single ~3,627 KB chunk (Monaco) and warns about chunks
>500KB. Dynamic-import the Monaco editor so the initial session load isn't dominated
by it. Perf only.

### 7. Stop shipping test files into the sandbox

`loadDefaultTemplateFiles` (`src/lib/server/sandbox/client.ts`) copies every `.ts`/`.json`
in `sandbox-template/` into `/app`, including `workflows.test.ts` and `vitest.config.ts`.
Harmless but untidy — exclude test/config files from what is written into the VM.

---

## Verified non-issues

Checked against current code and found already resolved (left here so they aren't
re-investigated):

- **`docs-generator` end-of-string regex** — uses the correct `(?![\s\S])` anchor
  (not a literal `\z`); the README-drift extraction is correct.
- **Proxy route lint + iframe e2e** — the `no-unused-vars` error is gone and the
  "iframe `src` is the proxied path" e2e test exists (`e2e/sandbox-ui.e2e.ts`).
- **Contract type tests** — `contracts.spec.ts` matches the real published unions;
  `bun run check` is clean.

## Known cosmetic noise (not tracked as work)

- A non-fatal `TypeError: Cannot read properties of undefined (reading 'wrapDynamicImport')`
  prints during `bun run test`. All tests still pass; it's a known vitest-browser ↔
  SvelteKit dev-init interaction, not a Sandman defect.
