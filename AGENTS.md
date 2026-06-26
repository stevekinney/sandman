# AGENTS.md — conventions for automated agents working on Sandman

## TDD mandate

Every track follows strict TDD:

1. Write the failing test first (describes the behaviour the contract demands).
2. Watch it fail for the right reason (`bun run test` or the relevant suite).
3. Write the minimum code to make it pass.
4. Refactor; confirm gates are still green.

Never weaken a gate to make it green: no `.skip`, `.only`, `it.todo`, `xfail`, no deleted
assertions, no `as any` to pass type-check, no raised timeouts to mask a hang. A red gate
is a signal to root-cause, not an obstacle to route around.

## Promise signals

Each track must emit a `promiseSignal` field in its `StructuredOutput` call when its work
is complete. The orchestrator reads this field to determine whether to proceed.

| Track                             | Signal                     |
| --------------------------------- | -------------------------- |
| Track 0 (scaffold + contracts)    | `SANDMAN_TRACK_0_COMPLETE` |
| Track A (E2B sandbox client)      | `SANDMAN_TRACK_A_COMPLETE` |
| Track B (proxy)                   | `SANDMAN_TRACK_B_COMPLETE` |
| Track C (Monaco editor)           | `SANDMAN_TRACK_C_COMPLETE` |
| Track D (workflow implementation) | `SANDMAN_TRACK_D_COMPLETE` |
| Track E (control plane UI)        | `SANDMAN_TRACK_E_COMPLETE` |

## Ownership map

| Path                                    | Owner track                     |
| --------------------------------------- | ------------------------------- |
| `package.json`, configs, `.env.example` | Track 0                         |
| `src/lib/contracts/**`                  | Track 0 (stub); Track D (final) |
| `src/lib/server/sandbox/**`             | Track A                         |
| `src/routes/sbx/[id]/ui/**`             | Track B                         |
| `src/lib/components/editor/**`          | Track C                         |
| `sandbox-template/**`                   | Track D                         |
| `src/lib/components/control-plane/**`   | Track E                         |

Tracks may READ any path; only the owner track may write to its path.

## No silent deferral

If you hit a blocker mid-task — a missing dependency, a gate still red after three distinct
fix attempts, an API that cannot be verified — stop and record it in the `blockers` array of
your `StructuredOutput`. Do not fake success, stub the hard part, or silently skip a test.
Truthful partial output is always preferred over fake-complete output.

## Contract seam — `writeFile` not `cp`

Track C calls `SandboxClient.writeFile(handle, path, contents)` to push edited code into
the sandbox before calling `SandboxClient.restartWorker(handle)`. The method name is
`writeFile`, not `cp`, `uploadFile`, or `syncFile`. Do not rename it.

## Cinder component imports

Always verify a Cinder component exists in
`node_modules/@lostgradient/cinder/dist/index.d.ts` before importing it.
Import from the per-component subpath (`@lostgradient/cinder/badge`, not the barrel), and
import the matching styles (`@lostgradient/cinder/badge/styles`).

## TypeScript conventions

- No enums — use `as const` objects with derived union types.
- No `any` — prefer `unknown` + type guards.
- No `as` assertions — prefer type guard functions using `is`.
- `import type` for type-only imports (verbatimModuleSyntax).
- Kebab-case filenames (`user-profile.ts`, not `userProfile.ts`).
- `.ts` and `.tsx` extensions only — no `.js`, `.mjs`, `.cjs`, `.jsx`.
