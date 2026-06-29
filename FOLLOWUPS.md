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

Next step: run `npx e2b@latest template build --name sandman` from the repo root with an
authenticated E2B account; copy the resulting template ID into `E2B_TEMPLATE_ID` in
`.env`; live-verify that cold-start latency drops and that `temporal --version` and
`npm install` pass as fast no-ops during bootstrap.

## Low

### 2. Remove the remaining Cinder dep-optimizer workaround

`vite.config.ts` still carries `optimizeDeps.exclude: ['@lostgradient/cinder']` because
the `browser` export condition in `@lostgradient/cinder@0.4.1` still resolves to
`./src/index.ts` (uncompiled TypeScript source), causing Rolldown's pre-bundler to hit
`js_parse_error` on `export type` in `.svelte.ts` files.

Remove the exclusion from `vite.config.ts` once
[stevekinney/cinder#534](https://github.com/stevekinney/cinder/issues/534) ships a fix
that routes the browser-context optimizer to compiled output (e.g., `dist/index.js`).
Re-verify all gates after removing the workaround.
