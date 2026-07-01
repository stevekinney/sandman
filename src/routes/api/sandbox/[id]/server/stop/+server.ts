/**
 * POST /api/sandbox/[id]/server/stop
 *
 * Stops the Temporal dev server process running inside the E2B sandbox.
 * Workflow state persists across the stop because the server runs with
 * `--db-filename`, so a subsequent `server/start` call recovers it. The
 * worker is stopped too — its connection dies with the server, and it has
 * no supervisor to restart itself.
 *
 * Response 204: empty — Temporal server (and worker) stopped
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
		await entry.client.stopServer(entry.handle);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
	return new Response(null, { status: 204 });
};
