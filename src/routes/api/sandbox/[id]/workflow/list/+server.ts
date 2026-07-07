/**
 * GET /api/sandbox/[id]/workflow/list
 *
 * Lists workflow executions inside the sandbox via `temporal workflow list`.
 * Used by reload restoration to re-attach the page to a live run — this is
 * app plumbing, not one of the teaching controls.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { WorkflowSummary } from '$lib/contracts/workflow-api';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	getTemporalCommandFailureMessage,
	runTemporalCommand
} from '$lib/server/sandbox/temporal-cli';

export const GET: RequestHandler = async (event) => {
	const { params } = event;
	await requireOwnedSandbox(event, params.id);

	const entry = getTemporalCliTarget(params.id);
	const result = await runTemporalCommand(entry, 'temporal workflow list --color never -o json');

	if (result.exitCode !== 0) {
		const message = getTemporalCommandFailureMessage(result, 'Temporal workflow list failed');
		return json({ error: message }, { status: 502 });
	}

	try {
		const parsed: unknown = JSON.parse(result.stdout);
		return json({ workflows: getWorkflowSummaries(parsed) });
	} catch {
		return json({ error: 'Temporal workflow list returned invalid JSON' }, { status: 502 });
	}
};

function getWorkflowSummaries(value: unknown): WorkflowSummary[] {
	const executions = getExecutions(value);
	return executions.map((execution) => ({
		workflowId: getNestedString(execution, ['execution', 'workflowId']) ?? '',
		runId: getNestedString(execution, ['execution', 'runId']) ?? '',
		status: normalizeStatus(getStringProperty(execution, 'status') ?? ''),
		type: getNestedString(execution, ['type', 'name'])
	}));
}

function getExecutions(value: unknown): unknown[] {
	if (!isRecord(value)) return [];
	const executions = value.executions;
	return Array.isArray(executions) ? executions : [];
}

function normalizeStatus(value: string): string {
	return value.replace(/^WORKFLOW_EXECUTION_STATUS_/, '');
}

function getNestedString(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const part of path) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return typeof current === 'string' ? current : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === 'string' ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
