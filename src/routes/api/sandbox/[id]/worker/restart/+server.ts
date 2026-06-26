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
import { Sandbox } from 'e2b';

/**
 * Re-launch the worker in the background. The exact start command depends
 * on how Track A bootstrapped the sandbox; `start-worker.sh` is the
 * conventional entry-point script placed there during provisioning.
 */
const RESTART_COMMAND = 'nohup bash /home/user/start-worker.sh > /tmp/worker.log 2>&1 &';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const sandbox = await Sandbox.connect(params.id);
		await sandbox.commands.run(RESTART_COMMAND);
		return new Response(null, { status: 204 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: `Failed to restart worker: ${message}` }, { status: 500 });
	}
};
