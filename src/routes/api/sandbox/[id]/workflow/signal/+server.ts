/**
 * POST /api/sandbox/[id]/workflow/signal
 *
 * Sends a typed signal to the named Temporal workflow running inside the
 * E2B sandbox.
 *
 * Request body: `{ workflowId: string; name: SignalName; payload: unknown }`
 * Response 204: empty
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Connection, Client } from '@temporalio/client';
import { Sandbox } from 'e2b';
import type { SignalName } from '$lib/contracts/workflow-api';

export const POST: RequestHandler = async ({ request, params }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { workflowId, name, payload } = body as {
		workflowId: string;
		name: SignalName;
		payload: unknown;
	};

	if (typeof workflowId !== 'string' || !workflowId.trim()) {
		return json({ error: 'workflowId is required' }, { status: 400 });
	}
	if (typeof name !== 'string' || !name.trim()) {
		return json({ error: 'signal name is required' }, { status: 400 });
	}

	const connection = await getSandboxConnection(params.id);
	try {
		const client = new Client({ connection });
		const handle = client.workflow.getHandle(workflowId);
		await handle.signal(name, payload);
		return new Response(null, { status: 204 });
	} finally {
		await connection.close();
	}
};

async function getSandboxConnection(sandboxId: string): Promise<Connection> {
	const sandbox = await Sandbox.connect(sandboxId);
	const hostUrl = sandbox.getHost(7233);
	const address = hostUrl.startsWith('http') ? new URL(hostUrl).host : hostUrl;
	return Connection.connect({ address });
}
