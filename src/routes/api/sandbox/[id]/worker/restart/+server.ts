/**
 * POST /api/sandbox/[id]/worker/restart
 *
 * Restarts the Temporal worker process inside the E2B sandbox after it was
 * killed. Once the worker reconnects to Temporal, any suspended workflows
 * resume exactly where they left off — demonstrating durable recovery.
 *
 * Response 204: empty — worker process restarted
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
	const status = await entry.client.restartWorker(entry.handle);
	if (!status.ok) {
		return json({ error: status.stderr ?? 'Failed to restart worker' }, { status: 500 });
	}
	return new Response(null, { status: 204 });
};
