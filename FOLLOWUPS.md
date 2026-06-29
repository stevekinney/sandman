# Follow-ups

Remaining work items for Sandman. Each item lists the concrete next step and the files
involved so it can be picked up cold.

## Low

### 1. Remove the remaining Cinder dep-optimizer workaround

`vite.config.ts` still carries `optimizeDeps.exclude: ['@lostgradient/cinder']` because
the `browser` export condition in `@lostgradient/cinder@0.4.1` still resolves to
`./src/index.ts` (uncompiled TypeScript source), so Rolldown's pre-bundler hits
`js_parse_error` on type-only statements in `.svelte.ts` files. Confirmed still broken
in 0.4.1 (the SSR sibling, cinder#533, _is_ fixed in 0.4.1).

Remove the exclusion from `vite.config.ts` once
[stevekinney/cinder#534](https://github.com/stevekinney/cinder/issues/534) (reopened with
a 0.4.1 repro) ships a fix that routes the browser-context optimizer to compiled output
(e.g. `dist/index.js`). Re-verify all gates after removing the workaround.

### 2. Remove the unused Drizzle/DB scaffold

Sandman uses no database, but the leftover `sv create` Drizzle scaffold forces a
`DATABASE_URL` env var (validated at server startup, so the built Node server crashes
without it). Nothing in the app imports `src/lib/server/db/**`. Remove `src/lib/server/db/`,
the `DATABASE_URL` entry in `src/env.ts`, `drizzle.config.ts`, the `db:*` scripts and
`drizzle-*` deps in `package.json`, and drop `DATABASE_URL` from `.env.example` and the
README env table. This removes a setup footgun (`cp .env.example .env` currently yields a
config that fails env validation).
