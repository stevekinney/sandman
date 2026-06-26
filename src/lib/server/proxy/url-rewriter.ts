/**
 * url-rewriter.ts — rewrites absolute upstream-origin URLs to the proxy prefix.
 *
 * Used by the proxy to ensure that embedded HTML and JSON (e.g. Temporal Web UI
 * config) reference the same-origin proxied path rather than pointing directly
 * at the sandbox upstream. This keeps the browser on the proxied origin and
 * prevents mixed-content / CORS issues inside the iframe.
 */

/**
 * Rewrites all occurrences of `upstreamOrigin` in `text` with `proxyPrefix`.
 *
 * Only absolute upstream-origin URLs are rewritten (those that start with
 * `upstreamOrigin`). Root-relative and relative paths are left untouched.
 *
 * @param text - The text to rewrite (HTML or JSON).
 * @param upstreamOrigin - The full `https://` origin of the upstream (trailing
 *   slash is tolerated and stripped before matching).
 * @param proxyPrefix - The proxy path prefix to substitute in, e.g.
 *   `/sbx/abc123/ui`. No trailing slash.
 */
export function rewriteUrls(text: string, upstreamOrigin: string, proxyPrefix: string): string {
	const origin = upstreamOrigin.endsWith('/') ? upstreamOrigin.slice(0, -1) : upstreamOrigin;
	return text.replaceAll(origin, proxyPrefix);
}
