# Follow-ups

Remaining work items for Sandman, ordered by priority. Each item lists the concrete
next step and the files involved so it can be picked up cold.

## Medium

### 1. Build a prebuilt E2B template

Bootstrap installs the Temporal CLI and the worker's npm deps on every boot
(~13–50s, network-dependent). Bake Node + the Temporal CLI + the worker deps into a
prebuilt E2B template image and reference it via the `E2B_TEMPLATE_ID` env var to cut
cold-start latency and remove a per-boot network dependency. Keep the install-on-boot
path (`ensureRuntimeDependencies` + `npm install` in `src/lib/server/sandbox/client.ts`)
as a fallback.

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
larger than 500KB. Dynamic-import the Monaco editor so the initial session load isn't
dominated by it. Perf only.

### 7. Stop shipping test files into the sandbox

`loadDefaultTemplateFiles` (`src/lib/server/sandbox/client.ts`) copies every `.ts`/`.json`
in `sandbox-template/` into `/app`, including `workflows.test.ts` and `vitest.config.ts`.
Harmless but untidy — exclude test/config files from what is written into the VM.
