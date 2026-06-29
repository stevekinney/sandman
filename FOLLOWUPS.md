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

### 2. Use Cinder form components in the control-plane forms

The control-plane forms hand-roll raw HTML inputs instead of Cinder components.
`start-order-form.svelte`, `signal-controls.svelte`, and `update-controls.svelte` use raw
`<input>`, `<select>`, `<textarea>`, `<label>`, and `<fieldset>` for their fields (they
already use Cinder `Button` for actions). Cinder ships `input`, `number-input`, `select`,
`textarea`, `form-field`, and `label` — migrate the fields to those for consistency and
accessibility. Also: the landing page (`src/routes/+page.svelte`) and the editor's file
tabs (`src/lib/components/editor/editor.svelte`) use raw `<button>` where Cinder `Button`
(or `Tabs`) would fit.
