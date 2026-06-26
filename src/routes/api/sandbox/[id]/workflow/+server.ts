/**
 * POST /api/sandbox/[id]/workflow
 *
 * Starts an `OrderFoodWorkflow` in the Temporal server running inside the
 * named E2B sandbox. Returns the workflow and run IDs on success.
 *
 * Request body: `OrderInput` (see src/lib/contracts/workflow-api.ts)
 * Response 201: `{ workflowId: string; runId: string }`
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Connection, Client } from '@temporalio/client';
import { Sandbox } from 'e2b';
import { TASK_QUEUE, ORDER_FOOD_WORKFLOW } from '$lib/contracts/workflow-api';
import type { OrderInput } from '$lib/contracts/workflow-api';

export const POST: RequestHandler = async ({ request, params }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const input = body as OrderInput;

	if (typeof input?.orderId !== 'string' || !input.orderId.trim()) {
		return json({ error: 'orderId is required' }, { status: 400 });
	}
	if (typeof input?.restaurantId !== 'string' || !input.restaurantId.trim()) {
		return json({ error: 'restaurantId is required' }, { status: 400 });
	}
	if (!Array.isArray(input?.items) || input.items.length === 0) {
		return json({ error: 'items must be a non-empty array' }, { status: 400 });
	}

	const connection = await getSandboxConnection(params.id);
	try {
		const client = new Client({ connection });
		const handle = await client.workflow.start(ORDER_FOOD_WORKFLOW, {
			taskQueue: TASK_QUEUE,
			workflowId: input.orderId,
			args: [input]
		});
		return json(
			{ workflowId: handle.workflowId, runId: handle.firstExecutionRunId },
			{ status: 201 }
		);
	} finally {
		await connection.close();
	}
};

/**
 * Open a Temporal gRPC connection to the Temporal dev server running inside
 * the E2B sandbox on port 7233.
 */
async function getSandboxConnection(sandboxId: string): Promise<Connection> {
	const sandbox = await Sandbox.connect(sandboxId);
	const hostUrl = sandbox.getHost(7233);
	// E2B getHost returns "hostname:port" or "https://…" — normalise to host string
	const address = hostUrl.startsWith('http') ? new URL(hostUrl).host : hostUrl;
	return Connection.connect({ address });
}
