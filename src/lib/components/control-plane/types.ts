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
	WorkflowSummary
} from '$lib/contracts/workflow-api';
import type { ProcessLiveness } from '$lib/contracts/sandbox';

// ---------------------------------------------------------------------------
// Workflow run identifiers
// ---------------------------------------------------------------------------

/** Identifiers returned when a workflow is successfully started. */
export type WorkflowRun = {
	workflowId: string;
	runId: string;
};

/** Kind of Temporal interaction shown in the teaching command log. */
export type CommandLogPrimitive = 'workflow' | 'signal' | 'query' | 'worker';

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
// Controller interface
// ---------------------------------------------------------------------------

/**
 * All control-plane operations against an active Temporal workflow.
 *
 * Production: `FetchController` makes HTTP calls to the `/api/sandbox/[id]/**` routes.
 * Tests: `MockTemporalController` records calls and returns configurable results.
 */
export type TemporalController = {
	/** Start the order workflow and return the resulting run identifiers. */
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

	/** Terminate the worker process inside the E2B sandbox. */
	killWorker(): Promise<void>;

	/** Restart the worker process inside the E2B sandbox. */
	restartWorker(): Promise<void>;

	/**
	 * Read current process liveness (Temporal server + worker) from the sandbox.
	 *
	 * A worker restart request is fire-and-forget: the route accepts it (204) long
	 * before the worker re-bundles, replays history, and starts polling again — and
	 * sometimes it never does. This lets the UI confirm the worker is *actually*
	 * back before it claims recovery, instead of optimistically reporting a
	 * restart that may not have happened.
	 */
	readProcessLiveness(): Promise<ProcessLiveness>;

	/**
	 * Stop the Temporal dev server inside the sandbox. Workflow state is
	 * persisted to disk; the worker dies with its server connection.
	 */
	stopServer(): Promise<void>;

	/**
	 * Start the Temporal dev server again: recovers persisted workflow state,
	 * waits for readiness, and restarts the worker.
	 */
	startServer(): Promise<void>;

	/**
	 * List workflow executions inside the sandbox. Served by the Temporal
	 * server (no worker needed) — used by reload restoration to re-attach to a
	 * live run.
	 */
	listWorkflows(): Promise<WorkflowSummary[]>;
};
