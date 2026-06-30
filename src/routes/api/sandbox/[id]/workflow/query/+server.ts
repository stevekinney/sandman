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
import { isQueryName } from '$lib/contracts/workflow-api';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	quoteShellArgument,
	runTemporalJsonCommand
} from '$lib/server/sandbox/temporal-cli';

export const GET: RequestHandler = async (event) => {
	const { url, params } = event;
	await requireOwnedSandbox(event, params.id);

	const workflowId = url.searchParams.get('workflowId');
	const name = url.searchParams.get('name');

	if (!workflowId) {
		return json({ error: 'workflowId query param is required' }, { status: 400 });
	}
	if (!name) {
		return json({ error: 'name query param is required' }, { status: 400 });
	}
	if (!isQueryName(name)) {
		return json({ error: `Unknown query name: ${name}` }, { status: 400 });
	}

	const entry = getTemporalCliTarget(params.id);
	const result = await runTemporalJsonCommand(
		entry,
		[
			'temporal workflow query',
			`--workflow-id ${quoteShellArgument(workflowId)}`,
			`--type ${quoteShellArgument(name)}`,
			'--color never',
			'-o json'
		].join(' ')
	);

	const queryResult = getQueryResult(result);
	return json(queryResult);
};

function getQueryResult(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || !('queryResult' in value)) {
		return value;
	}
	const queryResult = value.queryResult;
	if (!Array.isArray(queryResult)) return value;
	return queryResult[0] ?? null;
}
