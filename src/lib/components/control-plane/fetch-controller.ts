/**
 * fetch-controller.ts — production `TemporalController` that calls
 * the SvelteKit API routes via `fetch`.
 *
 * Route shape (owned by Track E):
 *   POST /api/sandbox/[id]/workflow         → start workflow
 *   POST /api/sandbox/[id]/workflow/signal  → send signal
 *   GET  /api/sandbox/[id]/workflow/query   → run query
 *   POST /api/sandbox/[id]/worker/kill      → kill worker
 *   POST /api/sandbox/[id]/worker/restart   → restart worker
 */

import type { TemporalController, WorkflowRun } from './types.ts';
import type {
	OrderInput,
	SignalName,
	SignalPayloadMap,
	QueryName,
	QueryReturnMap,
	WorkflowSummary
} from '$lib/contracts/workflow-api';
import type { ProcessLiveness } from '$lib/contracts/sandbox';

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
			const message = await readErrorMessage(res);
			throw new Error(`Signal ${name} failed: ${message}`);
		}
	}

	async query<N extends QueryName>(workflowId: string, name: N): Promise<QueryReturnMap[N]> {
		const url = new URL(`${this.base}/workflow/query`, window.location.href);
		url.searchParams.set('workflowId', workflowId);
		url.searchParams.set('name', name);

		const res = await fetch(url.toString());
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Query ${name} failed: ${message}`);
		}
		return res.json() as Promise<QueryReturnMap[N]>;
	}

	async killWorker(): Promise<void> {
		const res = await fetch(`${this.base}/worker/kill`, { method: 'POST' });
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Kill worker failed: ${message}`);
		}
	}

	async restartWorker(): Promise<void> {
		const res = await fetch(`${this.base}/worker/restart`, { method: 'POST' });
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Restart worker failed: ${message}`);
		}
	}

	async readProcessLiveness(): Promise<ProcessLiveness> {
		const res = await fetch(`${this.base}/status`);
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Read sandbox status failed: ${message}`);
		}
		const body: unknown = await res.json();
		const processes = isRecord(body) ? body.processes : undefined;
		// A `null`/absent/malformed `processes` means the backend can't vouch for
		// the sandbox (handle gone, or an unexpected shape) — treat that as "not
		// online" so the caller keeps waiting or surfaces a failure rather than
		// assuming recovery from data it can't trust.
		return isProcessLiveness(processes) ? processes : { serverOnline: false, workerOnline: false };
	}

	async stopServer(): Promise<void> {
		const res = await fetch(`${this.base}/server/stop`, { method: 'POST' });
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Stop server failed: ${message}`);
		}
	}

	async startServer(): Promise<void> {
		const res = await fetch(`${this.base}/server/start`, { method: 'POST' });
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Start server failed: ${message}`);
		}
	}

	async listWorkflows(): Promise<WorkflowSummary[]> {
		const res = await fetch(`${this.base}/workflow/list`);
		if (!res.ok) {
			const message = await readErrorMessage(res);
			throw new Error(`Workflow list failed: ${message}`);
		}
		const body = (await res.json()) as { workflows: WorkflowSummary[] };
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

/** Validate that a value has the `ProcessLiveness` shape (two booleans). */
function isProcessLiveness(value: unknown): value is ProcessLiveness {
	return (
		isRecord(value) &&
		typeof value.serverOnline === 'boolean' &&
		typeof value.workerOnline === 'boolean'
	);
}

function getStringProperty(value: Record<string, unknown>, key: string): string | null {
	const property = value[key];
	return typeof property === 'string' ? property : null;
}
