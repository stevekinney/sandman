/**
 * POST /api/sandbox/[id]/server/start
 *
 * Relaunches the Temporal dev server inside the E2B sandbox after a
 * `server/stop` call, waits for it to become reachable, re-registers the
 * custom Search Attributes (a fresh server process starts with none
 * registered), and restarts the worker against the new server process.
 *
 * Response 204: empty — Temporal server (and worker) restarted
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
		await entry.client.startServer(entry.handle);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
	return new Response(null, { status: 204 });
};
