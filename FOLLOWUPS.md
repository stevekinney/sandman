# Follow-ups

Remaining work items for Sandman. Each item lists the concrete next step and the files
involved so it can be picked up cold.

## Low

### 1. Remove the temporary Svelte pin after Cinder's 5.56 runtime issue is fixed

`package.json` pins `svelte` to `5.55.0` because `@lostgradient/cinder@0.6.0`
components fail under `svelte@5.56.4` with `TypeError: target.exclude.has is not a
function` during browser rendering. The failure reproduces with a bare Cinder `Badge`
render, so it is tracked upstream as
[stevekinney/cinder#656](https://github.com/stevekinney/cinder/issues/656).

Once Cinder publishes output compatible with its Svelte peer range, remove the pin,
restore the normal Svelte range, and re-run the full validation suite.
