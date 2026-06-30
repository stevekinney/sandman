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
import { isSignalName } from '$lib/contracts/workflow-api';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	quoteShellArgument,
	runTemporalCommand,
	writeTemporalJsonInput,
	getTemporalCommandFailureMessage
} from '$lib/server/sandbox/temporal-cli';

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

	if (!isSignalRequestBody(body)) {
		return json({ error: 'Request body must include workflowId and signal name' }, { status: 400 });
	}

	if (typeof body.workflowId !== 'string' || !body.workflowId.trim()) {
		return json({ error: 'workflowId is required' }, { status: 400 });
	}
	if (typeof body.name !== 'string' || !body.name.trim()) {
		return json({ error: 'signal name is required' }, { status: 400 });
	}
	if (!isSignalName(body.name)) {
		return json({ error: `Unknown signal name: ${body.name}` }, { status: 400 });
	}

	const entry = getTemporalCliTarget(params.id);
	const inputPath = await writeTemporalJsonInput(entry, 'signal', body.payload ?? {});
	const result = await runTemporalCommand(
		entry,
		[
			'temporal workflow signal',
			`--workflow-id ${quoteShellArgument(body.workflowId)}`,
			`--name ${quoteShellArgument(body.name)}`,
			`--input-file ${quoteShellArgument(inputPath)}`,
			'--color never',
			'-o json'
		].join(' ')
	);

	if (result.exitCode !== 0) {
		return json(
			{ error: getTemporalCommandFailureMessage(result, `Signal ${body.name} failed`) },
			{ status: 502 }
		);
	}

	return new Response(null, { status: 204 });
};

type SignalRequestBody = {
	workflowId: string;
	name: string;
	payload?: unknown;
};

function isSignalRequestBody(value: unknown): value is SignalRequestBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		'workflowId' in value &&
		'name' in value &&
		typeof value.workflowId === 'string' &&
		typeof value.name === 'string'
	);
}
