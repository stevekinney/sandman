/**
 * proxy.ts — SvelteKit reverse-proxy contract for the Temporal Web UI.
 *
 * The route /sbx/[id]/ui/[...path] proxies the Temporal Web UI running
 * inside the sandbox to the browser on the same origin. This avoids
 * mixed-content and CORS issues when embedding the UI in an iframe.
 */

/** The port Temporal Web UI listens on inside the sandbox. */
export const PROXIED_UI_PORT = 8233 as const;

/**
 * The complete set of sandbox ports this proxy is permitted to forward to.
 * Any request targeting a port not in this tuple must be rejected with 502.
 */
export const ALLOWED_UPSTREAM_PORTS = [8233] as const satisfies readonly number[];

/** Inferred element type of `ALLOWED_UPSTREAM_PORTS`. */
export type AllowedUpstreamPort = (typeof ALLOWED_UPSTREAM_PORTS)[number];

/**
 * Route parameter shape for the proxied UI SvelteKit route.
 * Maps to `src/routes/sbx/[id]/ui/[...path]/+server.ts`.
 */
export type ProxiedUiRouteParams = {
	/** The E2B sandbox identifier. Matches the sandbox handle `id`. */
	id: string;
	/** Remaining path segments forwarded verbatim to the upstream Temporal UI. */
	path: string[];
};

/** Typed error payload returned when the upstream sandbox is unreachable. */
export type ProxyError = {
	/** HTTP status code: 502 when the upstream is unreachable, 504 when it timed out. */
	status: 502 | 504;
	/** Human-readable description of why the proxy request failed. */
	message: string;
	/** The sandbox id that was targeted, for correlation. */
	sandboxId: string;
	/** ISO-8601 timestamp of the failure. */
	timestamp: string;
};
