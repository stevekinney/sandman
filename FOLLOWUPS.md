# Follow-ups

Remaining work items for Sandman. Each item lists the concrete next step and the files
involved so it can be picked up cold.

## Low

### 1. Harden `guards.ts` DB calls against silent failures

The `local/no-unguarded-db-call` ESLint rule only covers `src/routes/**/+server.ts`, so
the database calls inside `src/lib/server/security/guards.ts` (`getActiveDemoSession`,
`sandboxBelongsToSession`, `touchActiveDemoSession`, `touchSandboxSession`) are not
enforced. Today a raw DB failure in one of those escapes to `hooks.server.ts`'s
`handleError` backstop — logged, but as a generic 500 rather than a route-specific,
structured `503`. Broadening the rule's glob is not the fix (it would false-positive on
`repository.ts`/`connection.ts`, which _are_ the DB layer). Instead, decide per guard
whether a DB error should surface as a friendly `503` (as the route bodies now do) versus
propagate — note that `touchSessionActivity` _deliberately_ lets a `touchSandboxSession`
failure propagate so a mutation is rejected when expiry can't be verified
(`guards.test.ts` pins this), so this is a design pass, not a blanket try/catch wrap.
