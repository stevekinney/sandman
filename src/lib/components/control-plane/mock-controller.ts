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

export type UpdateCall = {
	workflowId: string;
	name: UpdateName;
	input: UpdateInputMap[UpdateName];
};

export type VisibilityCall = {
	filter: VisibilityFilter;
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

	/** All `update()` calls in order. */
	readonly updateCalls: UpdateCall[] = [];

	/** All `visibility()` calls in order. */
	readonly visibilityCalls: VisibilityCall[] = [];

	/** Number of `killWorker()` invocations. */
	killWorkerCount = 0;

	/** Number of `restartWorker()` invocations. */
	restartWorkerCount = 0;

	/** Number of `stopServer()` invocations. */
	stopServerCount = 0;

	/** Number of `startServer()` invocations. */
	startServerCount = 0;

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

	/**
	 * Per-update return values. If an update name has no entry, the mock
	 * returns `{}` cast to the expected type.
	 *
	 * ```ts
	 * controller.updateResults.set('applyPromoCode', { discountCents: 500, … });
	 * ```
	 */
	readonly updateResults = new Map<UpdateName, unknown>();

	/** Result returned by `visibility()`. */
	visibilityResult: VisibilityWorkflowSummary[] = [];

	/**
	 * When set, `update()` throws this rejection error instead of succeeding.
	 * Set to `null` (default) for the happy path.
	 *
	 * ```ts
	 * controller.updateRejection = { kind: 'rejection', reason: 'order-already-in-delivery' };
	 * ```
	 */
	updateRejection: UpdateRejectionError | null = null;

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
		return (this.queryResults.get(name) ?? null) as QueryReturnMap[N];
	}

	async update<N extends UpdateName>(
		workflowId: string,
		name: N,
		input: UpdateInputMap[N]
	): Promise<UpdateResultMap[N]> {
		this.updateCalls.push({ workflowId, name, input } as UpdateCall);
		if (this.updateRejection !== null) {
			throw this.updateRejection;
		}
		return (this.updateResults.get(name) ?? {}) as UpdateResultMap[N];
	}

	async killWorker(): Promise<void> {
		this.killWorkerCount++;
	}

	async restartWorker(): Promise<void> {
		this.restartWorkerCount++;
	}

	async stopServer(): Promise<void> {
		this.stopServerCount++;
	}

	async startServer(): Promise<void> {
		this.startServerCount++;
	}

	async visibility(filter: VisibilityFilter): Promise<VisibilityWorkflowSummary[]> {
		this.visibilityCalls.push({ filter });
		return this.visibilityResult;
	}
}
