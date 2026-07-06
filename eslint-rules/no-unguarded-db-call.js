/**
 * ESLint rule: no-unguarded-db-call
 *
 * Requires database calls made directly inside a `+server.ts` route handler to
 * sit within a `try`/`catch`, so a database failure becomes a controlled,
 * logged response (e.g. `logError` -> `error(503, ...)`) instead of falling
 * through SvelteKit's default `handleError` as a bare "Internal Error" that
 * hides the real failure. This encodes the fix for the production incident
 * where an unguarded `reserveSandboxSlot` / `createDemoSession` in a route
 * handler made a 100%-reproducible DB error completely invisible.
 *
 * What it flags: a call to a function imported from
 * `$lib/server/database/repository`, or a `.execute(` / `.transaction(` member
 * call, that is NOT lexically inside a `try` statement that has a `catch`
 * clause. Calls inside the `catch`/`finally` of such a `try` are exempt — they
 * are already error-handling code, and double-wrapping cleanup calls adds noise
 * without value.
 *
 * What it does NOT flag: `getDatabase` / `createDatabase` / `probeDatabase`
 * (connection helpers, no query I/O of their own), and any call outside the
 * `src/routes/**\/+server.ts` glob (enforced by eslint.config.js `files`), so
 * `repository.ts` and `connection.ts` themselves — which ARE the database
 * layer — are never matched.
 *
 * Opt out for a specific, justified call with ESLint's native directive:
 *   // eslint-disable-next-line local/no-unguarded-db-call -- <reason>
 *
 * Known limitation: the check is lexical, so a database call inside a callback
 * that is defined within a `try` but invoked asynchronously later would read as
 * "inside the try" even though that `catch` cannot catch it. No route currently
 * relies on that shape (the one async-IIFE bootstrap path has its own nested
 * try/catch), so this is accepted rather than papered over.
 */

const REPOSITORY_SOURCE = '$lib/server/database/repository';
const EXCLUDED_NAMES = new Set(['getDatabase', 'createDatabase', 'probeDatabase']);
const GUARDED_MEMBER_CALLS = new Set(['execute', 'transaction']);

/** True when any ancestor is a `try` statement that has a `catch` clause. */
function isInsideGuardedTry(node) {
	let current = node.parent;
	while (current) {
		if (current.type === 'TryStatement' && current.handler) return true;
		current = current.parent;
	}
	return false;
}

export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Require database calls in +server.ts route handlers to be wrapped in try/catch.'
		},
		schema: [],
		messages: {
			unguarded:
				'Database call in a +server.ts route handler must be wrapped in try/catch (-> logError -> error(503, ...)) so a DB failure is not swallowed as a bare Internal Error. Wrap it, or opt out with "// eslint-disable-next-line local/no-unguarded-db-call -- <reason>".'
		}
	},
	create(context) {
		const repositoryImportedNames = new Set();

		return {
			ImportDeclaration(node) {
				if (node.source.value !== REPOSITORY_SOURCE) return;
				for (const specifier of node.specifiers) {
					if (specifier.type === 'ImportSpecifier') {
						repositoryImportedNames.add(specifier.local.name);
					}
				}
			},
			CallExpression(node) {
				const callee = node.callee;
				let isDatabaseCall = false;

				if (callee.type === 'Identifier') {
					if (EXCLUDED_NAMES.has(callee.name)) return;
					isDatabaseCall = repositoryImportedNames.has(callee.name);
				} else if (
					callee.type === 'MemberExpression' &&
					callee.property.type === 'Identifier' &&
					!callee.computed &&
					GUARDED_MEMBER_CALLS.has(callee.property.name)
				) {
					isDatabaseCall = true;
				}

				if (!isDatabaseCall) return;
				if (isInsideGuardedTry(node)) return;

				context.report({ node, messageId: 'unguarded' });
			}
		};
	}
};
