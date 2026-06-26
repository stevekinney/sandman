# sandbox-template

This directory contains the Node.js / TypeScript code that runs **inside** the E2B Firecracker
MicroVM:

- `workflows.ts` — the food-ordering Temporal workflow (added by Track D)
- `activities.ts` — activity implementations (added by Track D)
- `worker.ts` — the Temporal worker bootstrap (added by Track D)

## Running tests

```sh
bun run test:workflows
```

Tests use a plain Vitest node environment so they can import `@temporalio/testing` without
the SvelteKit/Vite plugin stack.
