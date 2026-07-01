/**
 * fetch-controller.ts — production `TemporalController` that calls
 * the SvelteKit API routes via `fetch`.
 *
 * Route shape (owned by Track E):
 *   POST /api/sandbox/[id]/workflow         → start workflow
 *   POST /api/sandbox/[id]/workflow/signal  → send signal
 *   GET  /api/sandbox/[id]/workflow/query   → run query
 *   POST /api/sandbox/[id]/workflow/update  → run update
 *   GET  /api/sandbox/[id]/workflow/visibility → list via Search Attributes
 *   POST /api/sandbox/[id]/worker/kill      → kill worker
 *   POST /api/sandbox/[id]/worker/restart   → restart worker
 */

import type { TemporalController, WorkflowRun, UpdateRejectionError } from './types.ts';
import type {
	OrderInput,
	SignalName,
	SignalPayloadMap,
	QueryName,
	QueryReturnMap,
	UpdateName,
	UpdateInputMap,
	UpdateResultMap,
	VisibilityFilter,
	VisibilityWorkflowSummary
} from '$lib/contracts/workflow-api';

/**
 * HTTP-backed implementation of `TemporalController`.
 * Construct with the active sandbox ID; all operations use that ID.
 */
export class FetchController implements TemporalController {
	private readonly base: string;

	constructor(sandboxId: string) {
		this.base = `/api/sandbox/${sandboxId}`;
	}

	async start(input: OrderInput): Promise<WorkflowRun> {
		const res = await fetch(`${this.base}/workflow`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Failed to start workflow: ${message}`);
		}
		return res.json() as Promise<WorkflowRun>;
	}

	async signal<N extends SignalName>(
		workflowId: string,
		name: N,
		payload: SignalPayloadMap[N]
	): Promise<void> {
		const res = await fetch(`${this.base}/workflow/signal`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ workflowId, name, payload })
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Signal ${name} failed: ${text}`);
		}
	}

	async query<N extends QueryName>(workflowId: string, name: N): Promise<QueryReturnMap[N]> {
		const url = new URL(`${this.base}/workflow/query`, window.location.href);
		url.searchParams.set('workflowId', workflowId);
		url.searchParams.set('name', name);

		const res = await fetch(url.toString());
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Query ${name} failed: ${text}`);
		}
		return res.json() as Promise<QueryReturnMap[N]>;
	}

	async update<N extends UpdateName>(
		workflowId: string,
		name: N,
		input: UpdateInputMap[N]
	): Promise<UpdateResultMap[N]> {
		const res = await fetch(`${this.base}/workflow/update`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ workflowId, name, input })
		});

		if (res.status === 422) {
			const body = (await res.json()) as { reason: string };
			const rejection: UpdateRejectionError = {
				kind: 'rejection',
				reason: body.reason
			};
			throw rejection;
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Update ${name} failed: ${text}`);
		}
		return res.json() as Promise<UpdateResultMap[N]>;
	}

	async killWorker(): Promise<void> {
		const res = await fetch(`${this.base}/worker/kill`, { method: 'POST' });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Kill worker failed: ${text}`);
		}
	}

	async restartWorker(): Promise<void> {
		const res = await fetch(`${this.base}/worker/restart`, { method: 'POST' });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Restart worker failed: ${text}`);
		}
	}

	async visibility(filter: VisibilityFilter): Promise<VisibilityWorkflowSummary[]> {
		const url = new URL(`${this.base}/workflow/visibility`, window.location.href);
		if (filter.status !== undefined) url.searchParams.set('status', filter.status);
		if (filter.customerTier !== undefined) {
			url.searchParams.set('customerTier', filter.customerTier);
		}
		if (filter.restaurantId !== undefined)
			url.searchParams.set('restaurantId', filter.restaurantId);

		const res = await fetch(url.toString());
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Visibility query failed: ${text}`);
		}
		const body = (await res.json()) as { workflows: VisibilityWorkflowSummary[] };
		return body.workflows;
	}
}

async function readErrorMessage(response: Response): Promise<string> {
	const body = await response.text();
	if (body.trim().length === 0) return response.statusText || `HTTP ${response.status}`;

	const parsed = parseJsonObject(body);
	if (parsed !== null) {
		const message = getStringProperty(parsed, 'message') ?? getStringProperty(parsed, 'error');
		if (message !== null && message.trim().length > 0) return message;
	}

	return body;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isRecord(parsed)) return parsed;
	} catch {
		return null;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProperty(value: Record<string, unknown>, key: string): string | null {
	const property = value[key];
	return typeof property === 'string' ? property : null;
}
