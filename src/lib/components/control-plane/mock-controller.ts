/**
 * mock-controller.ts — test double for `TemporalController`.
 *
 * `MockTemporalController` records every method call and returns
 * configurable results. It is intentionally a plain class (no Svelte
 * runes) so it works in both browser and node test environments.
 *
 * Usage in browser tests:
 * ```ts
 * const controller = new MockTemporalController();
 * const session = new SessionState(controller, tour);
 * await session.placeOrder();
 * expect(controller.startCalls).toHaveLength(1);
 * ```
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

// ---------------------------------------------------------------------------
// Call record shapes
// ---------------------------------------------------------------------------

export type SignalCall = {
	workflowId: string;
	name: SignalName;
	payload: SignalPayloadMap[SignalName];
};

export type QueryCall = {
	workflowId: string;
	name: QueryName;
};

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

/**
 * In-memory mock of `TemporalController` for component and unit tests.
 *
 * All arrays and counters are public and mutable so tests can assert
 * exactly which calls were made and with which arguments.
 */
export class MockTemporalController implements TemporalController {
	// ---- call records -------------------------------------------------------

	/** All `start()` calls in order. */
	readonly startCalls: OrderInput[] = [];

	/** All `signal()` calls in order. */
	readonly signalCalls: SignalCall[] = [];

	/** All `query()` calls in order. */
	readonly queryCalls: QueryCall[] = [];

	/** Number of `killWorker()` invocations. */
	killWorkerCount = 0;

	/** Number of `restartWorker()` invocations. */
	restartWorkerCount = 0;

	/** Number of `readProcessLiveness()` invocations. */
	readProcessLivenessCount = 0;

	/** Number of `stopServer()` invocations. */
	stopServerCount = 0;

	/** Number of `startServer()` invocations. */
	startServerCount = 0;

	/** Number of `listWorkflows()` invocations. */
	listWorkflowsCount = 0;

	// ---- configurable results -----------------------------------------------

	/** Result returned by `start()`. Override to test different run IDs. */
	startResult: WorkflowRun = { workflowId: 'wf-test-1', runId: 'run-test-1' };

	/** When set, `start()` throws this error instead of succeeding. */
	startError: Error | null = null;

	/**
	 * Per-query return values. If a query name has no entry, the mock
	 * returns `null` cast to the expected type.
	 *
	 * ```ts
	 * controller.queryResults.set('getStatus', { status: 'PREPARING', … });
	 * ```
	 */
	readonly queryResults = new Map<QueryName, unknown>();

	/** When set, `query()` throws this error instead of succeeding. */
	queryError: Error | null = null;

	/** Result returned by `listWorkflows()`. */
	listWorkflowsResult: WorkflowSummary[] = [];

	/** When set, `listWorkflows()` throws this error instead of succeeding. */
	listWorkflowsError: Error | null = null;

	/**
	 * Liveness returned by `readProcessLiveness()`. Defaults to fully online so
	 * the happy-path restart confirms recovery immediately. Set `workerOnline`
	 * to `false` to simulate a restart that never brings the worker back.
	 */
	processLiveness: ProcessLiveness = { serverOnline: true, workerOnline: true };

	// ---- method implementations ---------------------------------------------

	async start(input: OrderInput): Promise<WorkflowRun> {
		this.startCalls.push(input);
		if (this.startError !== null) throw this.startError;
		return this.startResult;
	}

	async signal<N extends SignalName>(
		workflowId: string,
		name: N,
		payload: SignalPayloadMap[N]
	): Promise<void> {
		this.signalCalls.push({ workflowId, name, payload } as SignalCall);
	}

	async query<N extends QueryName>(workflowId: string, name: N): Promise<QueryReturnMap[N]> {
		this.queryCalls.push({ workflowId, name });
		if (this.queryError !== null) throw this.queryError;
		return (this.queryResults.get(name) ?? null) as QueryReturnMap[N];
	}

	async killWorker(): Promise<void> {
		this.killWorkerCount++;
	}

	async restartWorker(): Promise<void> {
		this.restartWorkerCount++;
	}

	async readProcessLiveness(): Promise<ProcessLiveness> {
		this.readProcessLivenessCount++;
		return this.processLiveness;
	}

	async stopServer(): Promise<void> {
		this.stopServerCount++;
	}

	async startServer(): Promise<void> {
		this.startServerCount++;
	}

	async listWorkflows(): Promise<WorkflowSummary[]> {
		this.listWorkflowsCount++;
		if (this.listWorkflowsError !== null) throw this.listWorkflowsError;
		return this.listWorkflowsResult;
	}
}
