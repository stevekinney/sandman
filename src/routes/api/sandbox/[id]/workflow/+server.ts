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
import { TASK_QUEUE, ORDER_FOOD_WORKFLOW } from '$lib/contracts/workflow-api';
import type { OrderInput } from '$lib/contracts/workflow-api';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox, touchSessionActivity } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	quoteShellArgument,
	runTemporalJsonCommand,
	writeTemporalJsonInput
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

	if (!isOrderInput(body)) {
		return json({ error: 'request body must be an OrderInput' }, { status: 400 });
	}
	const input = body;

	if (!isNonEmptyString(input.orderId)) {
		return json({ error: 'orderId is required' }, { status: 400 });
	}
	if (!isNonEmptyString(input.restaurantId)) {
		return json({ error: 'restaurantId is required' }, { status: 400 });
	}
	if (!Array.isArray(input.items) || input.items.length === 0) {
		return json({ error: 'items must be a non-empty array' }, { status: 400 });
	}

	await touchSessionActivity(event, params.id);

	const entry = getTemporalCliTarget(params.id);
	const inputPath = await writeTemporalJsonInput(entry, 'start-order', input);
	const result = await runTemporalJsonCommand(
		entry,
		[
			'temporal workflow start',
			`--task-queue ${quoteShellArgument(TASK_QUEUE)}`,
			`--type ${quoteShellArgument(ORDER_FOOD_WORKFLOW)}`,
			`--workflow-id ${quoteShellArgument(input.orderId)}`,
			`--input-file ${quoteShellArgument(inputPath)}`,
			'--color never',
			'-o json'
		].join(' ')
	);

	if (!isWorkflowStartResult(result)) {
		return json({ error: 'Temporal start returned an invalid response' }, { status: 502 });
	}

	return json({ workflowId: result.workflowId, runId: result.runId }, { status: 201 });
};

function isOrderInput(value: unknown): value is OrderInput {
	return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isWorkflowStartResult(value: unknown): value is { workflowId: string; runId: string } {
	if (typeof value !== 'object' || value === null) return false;
	if (!('workflowId' in value) || !('runId' in value)) return false;
	return (
		typeof value.workflowId === 'string' &&
		value.workflowId.length > 0 &&
		typeof value.runId === 'string' &&
		value.runId.length > 0
	);
}
