/**
 * +page.server.ts — load function for the Sandman demo session page.
 *
 * Validates the sessionId route parameter and passes it to the component.
 * The sandbox corresponding to this ID may or may not be provisioned yet —
 * the component handles the "not ready" state gracefully.
 *
 * SSR is disabled because:
 *  - The session page is fully interactive (Monaco editor, iframe, WebSocket).
 *  - SSR triggers lucide-svelte ".svelte" imports that Node.js can't resolve
 *    without bundling, and SSR adds no crawlability value for this view.
 */

import type { PageServerLoad } from './$types';

/** Disable server-side rendering — the session UI is a pure client SPA. */
export const ssr = false;

export const load: PageServerLoad = async ({ params }) => {
	return {
		/** The E2B sandbox ID that drives the three-panel session layout. */
		sandboxId: params.sessionId
	};
};
