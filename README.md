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
| `E2B_TEMPLATE_ID`        | The E2B sandbox template ID pre-loaded with Node.js and the Temporal CLI |
| `SANDMAN_SESSION_TTL_MS` | Sandbox lifetime in milliseconds (default: `300000` / 5 min)             |

## Verification gates

Run these in order to confirm the project is healthy:

```sh
bun run format:check   # prettier formatting check
bun run lint           # eslint
bun run check          # svelte-check + TypeScript
bun run build          # vite production build
bun run test           # vitest (unit + browser component)
bun run test:workflows # vitest over sandbox-template/ (passWithNoTests until Track D ships)
bun run test:e2e       # Playwright end-to-end
```
