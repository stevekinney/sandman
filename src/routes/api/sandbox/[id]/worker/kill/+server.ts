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
import { requireOwnedSandbox } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	getTemporalCommandFailureMessage,
	runTemporalCommand
} from '$lib/server/sandbox/temporal-cli';

/**
 * The worker process is a Node.js script started by the sandbox bootstrap.
 * We kill it by sending SIGTERM to any process matching the worker entry-point
 * name. The exact command depends on how Track A provisioned the sandbox;
 * `temporal-worker` is the conventional process tag used in the bootstrap.
 */
const KILL_COMMAND =
	"pkill -SIGTERM -f 'node_modules/.bin/tsx worker.ts' || pkill -SIGTERM -f 'tsx worker.ts' || true";

export const POST: RequestHandler = async (event) => {
	const { params } = event;
	assertSameOrigin(event);
	await requireOwnedSandbox(event, params.id);

	const entry = getTemporalCliTarget(params.id);
	const result = await runTemporalCommand(entry, KILL_COMMAND);
	if (result.exitCode !== 0) {
		return json(
			{ error: getTemporalCommandFailureMessage(result, 'Failed to kill worker') },
			{ status: 500 }
		);
	}
	return new Response(null, { status: 204 });
};
