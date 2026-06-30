/**
 * types.ts — shared interface and helper types for the control-plane UI.
 *
 * The `TemporalController` interface is the seam between the UI components
 * and the actual Temporal/E2B plumbing. Production uses `FetchController`;
 * tests inject `MockTemporalController`.
 */

import type {
	OrderInput,
	SignalName,
	SignalPayloadMap,
	QueryName,
	QueryReturnMap,
	UpdateName,
	UpdateInputMap,
	UpdateResultMap
} from '$lib/contracts/workflow-api';

// ---------------------------------------------------------------------------
// Workflow run identifiers
// ---------------------------------------------------------------------------

/** Identifiers returned when a workflow is successfully started. */
export type WorkflowRun = {
	workflowId: string;
	runId: string;
};

/** Kind of Temporal interaction shown in the teaching command log. */
export type CommandLogPrimitive = 'workflow' | 'signal' | 'query' | 'update' | 'worker';

/** Status of a command recorded by the control plane. */
export type CommandLogStatus = 'running' | 'succeeded' | 'failed';

/**
 * One UI action mapped to the API route and Temporal CLI primitive it drives.
 * The log is intentionally serializable so it can be rendered, tested, and
 * copied into workshop notes without keeping controller instances around.
 */
export type CommandLogEntry = {
	id: number;
	label: string;
	primitive: CommandLogPrimitive;
	apiRoute: string;
	temporalCommand: string;
	workflowId?: string;
	runId?: string;
	payload?: unknown;
	result?: unknown;
	error?: string;
	status: CommandLogStatus;
	timestamp: string;
};

/** Partial command metadata emitted before a controller call is executed. */
export type CommandLogDraft = Omit<CommandLogEntry, 'id' | 'status' | 'timestamp'>;

// ---------------------------------------------------------------------------
// Update rejection
// ---------------------------------------------------------------------------

/**
 * Discriminated error thrown by `TemporalController.update` when the
 * Temporal update validator rejects the request synchronously.
 *
 * Catch this in components to show the rejection reason inline.
 */
export type UpdateRejectionError = {
	kind: 'rejection';
	reason: string;
};

/**
 * Type guard for `UpdateRejectionError`.
 * Use in catch blocks to distinguish validator rejections from network errors.
 */
export function isUpdateRejectionError(error: unknown): error is UpdateRejectionError {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as Record<string, unknown>)['kind'] === 'rejection'
	);
}

// ---------------------------------------------------------------------------
// Controller interface
// ---------------------------------------------------------------------------

/**
 * All control-plane operations against an active Temporal workflow.
 *
 * Production: `FetchController` makes HTTP calls to the `/api/sandbox/[id]/**` routes.
 * Tests: `MockTemporalController` records calls and returns configurable results.
 */
export type TemporalController = {
	/** Start the `OrderFoodWorkflow` and return the resulting run identifiers. */
	start(input: OrderInput): Promise<WorkflowRun>;

	/** Send a typed signal to an active workflow. */
	signal<N extends SignalName>(
		workflowId: string,
		name: N,
		payload: SignalPayloadMap[N]
	): Promise<void>;

	/**
	 * Execute a query against an active workflow.
	 * Queries are read-only and never advance workflow execution.
	 */
	query<N extends QueryName>(workflowId: string, name: N): Promise<QueryReturnMap[N]>;

	/**
	 * Execute an update against an active workflow.
	 * Throws `UpdateRejectionError` when the Temporal validator rejects the request.
	 */
	update<N extends UpdateName>(
		workflowId: string,
		name: N,
		input: UpdateInputMap[N]
	): Promise<UpdateResultMap[N]>;

	/** Terminate the worker process inside the E2B sandbox. */
	killWorker(): Promise<void>;

	/** Restart the worker process inside the E2B sandbox. */
	restartWorker(): Promise<void>;
};
