/**
 * GET /api/sandbox/[id]/workflow/query?workflowId=…&name=…
 *
 * Executes a Temporal query against the named workflow running inside the
 * E2B sandbox and returns the result as JSON. Queries are read-only and
 * never advance workflow execution.
 *
 * Query params: `workflowId`, `name` (QueryName)
 * Response 200: query result
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Connection, Client } from '@temporalio/client';
import { Sandbox } from 'e2b';
import type { QueryName } from '$lib/contracts/workflow-api';
import { requireOwnedSandbox } from '$lib/server/security/guards';

export const GET: RequestHandler = async (event) => {
	const { url, params } = event;
	await requireOwnedSandbox(event, params.id);

	const workflowId = url.searchParams.get('workflowId');
	const name = url.searchParams.get('name') as QueryName | null;

	if (!workflowId) {
		return json({ error: 'workflowId query param is required' }, { status: 400 });
	}
	if (!name) {
		return json({ error: 'name query param is required' }, { status: 400 });
	}

	const connection = await getSandboxConnection(params.id);
	try {
		const client = new Client({ connection });
		const handle = client.workflow.getHandle(workflowId);
		const result = await handle.query(name);
		return json(result);
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
