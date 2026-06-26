/**
 * +server.ts — GET/POST /sbx/[id]/ui/[...path]
 *
 * Reverse-proxy for the Temporal Web UI running inside an E2B sandbox.
 * All traffic is forwarded to `https://<handle.host(8233)>/<path>` with
 * the `e2b-traffic-access-token` header injected server-side.
 *
 * SECURITY: The access token NEVER reaches the browser. It is set only on
 * the outbound upstream request by `proxyRequest` in proxy.ts.
 *
 * The sandbox handle is resolved via `configureSandboxResolver`, which
 * Track A must call from `hooks.server.ts` once the SandboxClient is ready.
 */

import type { RequestHandler } from './$types';
import type { SandboxHandle } from '$lib/contracts/sandbox';
import { PROXIED_UI_PORT, type AllowedUpstreamPort } from '$lib/contracts/proxy';
import { proxyRequest } from '$lib/server/proxy/proxy';
import type { ProxyError } from '$lib/contracts/proxy';

/** Resolves a live sandbox handle for the given sandbox ID. */
export type SandboxResolver = (id: string) => Promise<SandboxHandle | null>;

/**
 * Module-level sandbox resolver — injected by Track A via
 * `_configureSandboxResolver`. Returns `null` for all IDs until configured,
 * which causes the route to respond with 502.
 */
let resolve: SandboxResolver = async (_id: string): Promise<SandboxHandle | null> => null;

/**
 * Wire up the sandbox handle resolver.
 *
 * The `_` prefix satisfies SvelteKit's `+server.ts` export allow-list.
 *
 * Track A should call this from `hooks.server.ts` once the SandboxClient is
 * available. Until then, every proxy request returns a typed 502 error.
 */
export function _configureSandboxResolver(resolver: SandboxResolver): void {
	resolve = resolver;
}

async function handleRequest(event: Parameters<RequestHandler>[0]): Promise<Response> {
	const { id, path } = event.params;

	let handle: SandboxHandle | null;
	try {
		handle = await resolve(id);
	} catch {
		handle = null;
	}

	if (handle === null) {
		const payload: ProxyError = {
			status: 502,
			message: `No sandbox found with id "${id}". Track A must call configureSandboxResolver() from hooks.server.ts.`,
			sandboxId: id,
			timestamp: new Date().toISOString()
		};
		return new Response(JSON.stringify(payload), {
			status: 502,
			headers: { 'content-type': 'application/json' }
		});
	}

	// E2B's getHost returns a bare hostname; we build the full https:// origin.
	// The satisfies check ensures PROXIED_UI_PORT stays within ALLOWED_UPSTREAM_PORTS.
	const port = PROXIED_UI_PORT satisfies AllowedUpstreamPort;
	const upstreamHost = handle.host(port);
	const upstreamOrigin = upstreamHost.startsWith('http') ? upstreamHost : `https://${upstreamHost}`;

	return proxyRequest({
		upstreamOrigin,
		accessToken: handle.accessToken,
		sandboxId: id,
		path: path ?? '',
		proxyPrefix: `/sbx/${id}/ui`,
		request: event.request
	});
}

export const GET: RequestHandler = handleRequest;
export const POST: RequestHandler = handleRequest;
