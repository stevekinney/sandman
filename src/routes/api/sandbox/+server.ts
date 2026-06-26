/**
 * +server.ts — POST /api/sandbox
 *
 * Provisions a new E2B sandbox and registers it so the files and proxy routes
 * can resolve it by ID.
 *
 * GATED on `E2B_API_KEY`: returns 503 with a descriptive body when the key is
 * absent so the browser can degrade gracefully to demo mode.
 *
 * Response: `{ sandboxId: string; uiUrl: string }`
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSandboxRegistry, registerHandle } from '$lib/server/sandbox/registry';

export const POST: RequestHandler = async () => {
	const apiKey = process.env['E2B_API_KEY'];
	if (!apiKey) {
		throw error(
			503,
			'E2B_API_KEY is not set — live sandboxes are unavailable. ' +
				'Set E2B_API_KEY in your environment to enable provisioning.'
		);
	}

	const registry = getSandboxRegistry();
	const handle = await registry.client.provision();
	registerHandle(handle.id, handle);

	// Bootstrap runs asynchronously so the page can render while the sandbox
	// warms up. The worker status strip will reflect readiness.
	void registry.client.bootstrap(handle);

	return json({ sandboxId: handle.id });
};
