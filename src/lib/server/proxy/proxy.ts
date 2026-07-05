/**
 * proxy.ts — core reverse-proxy logic for the Temporal Web UI.
 *
 * `proxyRequest` is the single function that handles one HTTP round-trip to
 * the upstream sandbox. It is intentionally pure of any SvelteKit / E2B
 * concerns so it can be unit-tested against a fake upstream without any
 * external infrastructure.
 *
 * SECURITY CONTRACT: `e2b-traffic-access-token` is injected on the upstream
 * request ONLY. It is stripped from upstream responses before they reach the
 * browser, and it is never embedded in buffered HTML/JSON bodies.
 */

import type { ProxyError } from '$lib/contracts/proxy';
import { rewriteUrls } from './url-rewriter.ts';

/**
 * Hop-by-hop headers that MUST NOT be forwarded in either direction.
 * Defined in RFC 7230 §6.1.
 */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade'
]);

/**
 * Response headers from upstream that MUST be stripped before the response
 * reaches the browser. These either block iframe embedding or expose internals.
 */
const BLOCKED_RESPONSE_HEADERS = new Set(['x-frame-options', 'e2b-traffic-access-token']);

/**
 * Cap on a single upstream (sandbox Temporal UI) request. A wedged or
 * slow-loris'd sandbox would otherwise hold this fetch — and the containing
 * request handler — open indefinitely, and a UI page load fans out into many
 * such sub-requests. 30s comfortably covers a healthy response.
 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Returns true for content-types that should be buffered and URL-rewritten. */
function isRewritable(contentType: string): boolean {
	return contentType.startsWith('text/html') || contentType.startsWith('application/json');
}

/** Parameters for a single proxy round-trip. */
export type ProxyRequestParams = {
	/** Full `https://` origin of the upstream Temporal Web UI (no trailing slash). */
	upstreamOrigin: string;
	/**
	 * E2B traffic access token. Injected server-side ONLY — never forwarded
	 * to the browser.
	 */
	accessToken: string;
	/** E2B sandbox ID, used in error payloads for correlation. */
	sandboxId: string;
	/**
	 * Path to append after the upstream origin (e.g. `"api/namespaces"` or
	 * `""` for the root). A leading slash is added automatically if missing.
	 */
	path: string;
	/**
	 * Same-origin proxy prefix the route is mounted at (e.g. `/sbx/abc/ui`).
	 * Used to rewrite absolute upstream URLs inside HTML/JSON bodies so that
	 * embedded resources continue to load through the proxy.
	 */
	proxyPrefix: string;
	/** The incoming browser request to forward. */
	request: Request;
};

/**
 * Proxies a single HTTP request to the upstream Temporal Web UI and returns
 * a browser-safe `Response`.
 *
 * Behaviour:
 * - Injects `e2b-traffic-access-token` on the upstream request.
 * - Forces `Accept-Encoding: identity` so response bodies are never compressed.
 * - Strips hop-by-hop and blocking headers from both request and response.
 * - Buffers `text/html` and `application/json` responses to rewrite absolute
 *   upstream URLs to the proxy prefix; everything else is streamed.
 * - Sets `Content-Security-Policy: frame-ancestors 'self'` on every response.
 * - Returns a typed 502 `ProxyError` JSON body when the upstream is unreachable.
 */
export async function proxyRequest({
	upstreamOrigin,
	accessToken,
	sandboxId,
	path,
	proxyPrefix,
	request
}: ProxyRequestParams): Promise<Response> {
	const origin = upstreamOrigin.endsWith('/') ? upstreamOrigin.slice(0, -1) : upstreamOrigin;
	const pathPart = path === '' ? '' : path.startsWith('/') ? path : `/${path}`;
	const upstreamUrl = `${origin}${pathPart}`;

	// Build forwarded request headers — strip hop-by-hop and Host, inject token.
	const forwardHeaders = new Headers();
	for (const [key, value] of request.headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === 'host') continue;
		if (HOP_BY_HOP.has(lower)) continue;
		forwardHeaders.set(key, value);
	}
	forwardHeaders.set('e2b-traffic-access-token', accessToken);
	// Prevent compressed bodies so buffered rewrites are safe.
	forwardHeaders.set('accept-encoding', 'identity');

	// Buffer the request body (handles POST/PUT; avoids fetch duplex issues).
	const reqBody =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, {
			method: request.method,
			headers: forwardHeaders,
			body: reqBody,
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
	} catch (cause) {
		const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
		const error: ProxyError = {
			status: timedOut ? 504 : 502,
			message: timedOut
				? `upstream did not respond within ${UPSTREAM_TIMEOUT_MS}ms`
				: cause instanceof Error
					? cause.message
					: 'upstream fetch failed',
			sandboxId,
			timestamp: new Date().toISOString()
		};
		return new Response(JSON.stringify(error), {
			status: error.status,
			headers: { 'content-type': 'application/json' }
		});
	}

	// Build response headers — strip hop-by-hop, blocked headers, and
	// content-length (which changes when bodies are rewritten).
	const responseHeaders = new Headers();
	for (const [key, value] of upstream.headers.entries()) {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (BLOCKED_RESPONSE_HEADERS.has(lower)) continue;
		if (lower === 'content-length') continue;
		responseHeaders.set(key, value);
	}
	// Allow this page to be embedded in our own iframes.
	responseHeaders.set('content-security-policy', "frame-ancestors 'self'");

	const contentType = upstream.headers.get('content-type') ?? '';

	if (isRewritable(contentType)) {
		// Buffer the body so we can rewrite upstream URLs before sending.
		const text = await upstream.text();
		const rewritten = rewriteUrls(text, origin, proxyPrefix);
		responseHeaders.set('content-type', contentType);
		return new Response(rewritten, {
			status: upstream.status,
			headers: responseHeaders
		});
	}

	// Stream all other content types through unchanged.
	return new Response(upstream.body, {
		status: upstream.status,
		headers: responseHeaders
	});
}
