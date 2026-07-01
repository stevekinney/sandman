/**
 * POST /api/sandbox/[id]/worker/kill
 *
 * Terminates the Temporal worker process running inside the E2B sandbox.
 * This is the "Kill Worker" step of the durable-recovery demo: after the
 * worker dies, the workflow remains suspended in Temporal until the worker
 * is restarted.
 *
 * Response 204: empty — worker process terminated
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox, touchSessionActivity } from '$lib/server/security/guards';
import { getTemporalCliTarget } from '$lib/server/sandbox/temporal-cli';

export const POST: RequestHandler = async (event) => {
	const { params } = event;
	assertSameOrigin(event);
	await requireOwnedSandbox(event, params.id);
	await touchSessionActivity(event, params.id);

	const entry = getTemporalCliTarget(params.id);
	try {
		await entry.client.killWorker(entry.handle);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
	return new Response(null, { status: 204 });
};
