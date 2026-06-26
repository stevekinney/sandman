/**
 * hooks.server.ts — SvelteKit server hooks.
 *
 * Wires the sandbox resolvers for:
 *  - POST /api/sandbox/[id]/files  (Track C file write route)
 *  - GET/POST /sbx/[id]/ui/**      (Track B Temporal UI proxy route)
 *
 * Both routes use a module-level resolver injected here once at startup.
 * The resolver looks up live sandbox sessions from the shared registry.
 *
 * Until a sandbox is provisioned via `registerHandle()`, the resolvers
 * return the correct "not found" signal:
 *  - Files route: throws (→ 503 response)
 *  - Proxy route: returns null (→ 502 ProxyError response)
 */

import type { Handle } from '@sveltejs/kit';
import { _configureSandboxResolver as configureFilesResolver } from './routes/api/sandbox/[id]/files/+server.ts';
import { _configureSandboxResolver as configureProxyResolver } from './routes/sbx/[id]/ui/[...path]/+server.ts';
import { resolveEntry, resolveHandle } from '$lib/server/sandbox/registry';

// ---------------------------------------------------------------------------
// Configure both route resolvers at module load time (process startup).
// ---------------------------------------------------------------------------

configureFilesResolver(async (id: string) => {
	const entry = resolveEntry(id);
	if (!entry) {
		throw new Error(
			`Sandbox "${id}" is not registered. Provision it first via /api/sandbox/[id]/provision.`
		);
	}
	return entry;
});

configureProxyResolver(async (id: string) => resolveHandle(id));

// ---------------------------------------------------------------------------
// Handle hook — attach sandbox ID to locals if present in the URL.
// ---------------------------------------------------------------------------

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
