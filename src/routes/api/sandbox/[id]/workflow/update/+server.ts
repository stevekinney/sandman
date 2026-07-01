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
import { isUpdateName } from '$lib/contracts/workflow-api';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox, touchSessionActivity } from '$lib/server/security/guards';
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
	await touchSessionActivity(event, params.id);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!isUpdateRequestBody(body)) {
		return json({ error: 'Request body must include workflowId and update name' }, { status: 400 });
	}

	if (typeof body.workflowId !== 'string' || !body.workflowId.trim()) {
		return json({ error: 'workflowId is required' }, { status: 400 });
	}
	if (typeof body.name !== 'string' || !body.name.trim()) {
		return json({ error: 'update name is required' }, { status: 400 });
	}
	if (!isUpdateName(body.name)) {
		return json({ error: `Unknown update name: ${body.name}` }, { status: 400 });
	}

	const entry = getTemporalCliTarget(params.id);
	const inputPath = await writeTemporalJsonInput(entry, 'update', body.input ?? {});
	const result = await runTemporalCommand(
		entry,
		[
			'temporal workflow update execute',
			`--workflow-id ${quoteShellArgument(body.workflowId)}`,
			`--name ${quoteShellArgument(body.name)}`,
			`--input-file ${quoteShellArgument(inputPath)}`,
			'--color never',
			'-o json'
		].join(' ')
	);

	if (result.exitCode !== 0) {
		const reason = extractUpdateRejectionReason(result.stdout);
		if (reason !== null) return json({ reason }, { status: 422 });
		return json(
			{ error: getTemporalCommandFailureMessage(result, `Update ${body.name} failed`) },
			{ status: 502 }
		);
	}

	try {
		const parsed: unknown = JSON.parse(result.stdout);
		return json(getUpdateResult(parsed));
	} catch {
		return json({ error: 'Temporal update returned invalid JSON' }, { status: 502 });
	}
};

type UpdateRequestBody = {
	workflowId: string;
	name: string;
	input?: unknown;
};

function isUpdateRequestBody(value: unknown): value is UpdateRequestBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		'workflowId' in value &&
		'name' in value &&
		typeof value.workflowId === 'string' &&
		typeof value.name === 'string'
	);
}

function extractUpdateRejectionReason(output: string): string | null {
	const marker = 'unable to update workflow: ';
	const markerIndex = output.indexOf(marker);
	if (markerIndex === -1) return null;
	const afterMarker = output.slice(markerIndex + marker.length);
	const typeIndex = afterMarker.indexOf(' (type: UPDATE_REJECTED');
	if (typeIndex === -1) return null;
	const reason = afterMarker.slice(0, typeIndex).trim();
	return reason.length > 0 ? reason : null;
}

function getUpdateResult(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || !('result' in value)) return value;
	return value.result;
}
