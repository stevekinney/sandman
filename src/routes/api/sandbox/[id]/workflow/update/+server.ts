/**
 * POST /api/sandbox/[id]/workflow/update
 *
 * Executes a Temporal update against the named workflow.
 * Returns 200 with the update result on success.
 * Returns 422 with `{ reason: string }` when the update validator rejects.
 *
 * Request body: `{ workflowId: string; name: UpdateName; input: unknown }`
 * Response 200: update result
 * Response 422: `{ reason: string }` — validator rejection
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Connection, Client } from '@temporalio/client';
import { Sandbox } from 'e2b';
import type { UpdateName } from '$lib/contracts/workflow-api';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox } from '$lib/server/security/guards';

export const POST: RequestHandler = async (event) => {
	const { request, params } = event;
	assertSameOrigin(event);
	await requireOwnedSandbox(event, params.id);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { workflowId, name, input } = body as {
		workflowId: string;
		name: UpdateName;
		input: unknown;
	};

	if (typeof workflowId !== 'string' || !workflowId.trim()) {
		return json({ error: 'workflowId is required' }, { status: 400 });
	}
	if (typeof name !== 'string' || !name.trim()) {
		return json({ error: 'update name is required' }, { status: 400 });
	}

	const connection = await getSandboxConnection(params.id);
	try {
		const client = new Client({ connection });
		const handle = client.workflow.getHandle(workflowId);

		// Temporal update validators reject synchronously; the SDK surfaces this
		// as a WorkflowUpdateRejectedError. We translate it to HTTP 422 so the
		// browser client can display the reason inline without an unhandled error.
		try {
			const result = await handle.executeUpdate(name, { args: [input] });
			return json(result);
		} catch (err) {
			// WorkflowUpdateRejectedError has a `cause.failure.message` that
			// contains the validator's rejection string.
			if (isUpdateRejectedError(err)) {
				const reason = extractRejectionReason(err);
				return json({ reason }, { status: 422 });
			}
			throw err;
		}
	} finally {
		await connection.close();
	}
};

/**
 * Detect Temporal's `WorkflowUpdateRejectedError` by duck-typing — avoids a
 * direct import of `@temporalio/common` in this route file.
 */
function isUpdateRejectedError(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		(err as Record<string, unknown>)['name'] === 'WorkflowUpdateRejectedError'
	);
}

/**
 * Extract the rejection reason string from the error.
 * Temporal puts it in `err.cause?.failure?.message`.
 */
function extractRejectionReason(err: unknown): string {
	const e = err as Record<string, unknown>;
	const cause = e['cause'] as Record<string, unknown> | undefined;
	const failure = cause?.['failure'] as Record<string, unknown> | undefined;
	const message = failure?.['message'];
	return typeof message === 'string' ? message : String(err);
}

async function getSandboxConnection(sandboxId: string): Promise<Connection> {
	const sandbox = await Sandbox.connect(sandboxId);
	const hostUrl = sandbox.getHost(7233);
	const address = hostUrl.startsWith('http') ? new URL(hostUrl).host : hostUrl;
	return Connection.connect({ address });
}
