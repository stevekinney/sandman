/**
 * events.ts — live event-rail shape for the control-plane UI.
 *
 * The event rail streams Temporal history events to the browser so the
 * control plane can render a live timeline without polling the Temporal
 * HTTP API directly. Track D (workflow implementation) and Track E
 * (control-plane UI) both reference these types.
 */

/**
 * Coarse-grained category used to group and colour-code events in the UI.
 * Track D may narrow specific event types further inside workflow-api.ts.
 */
export const WORKFLOW_EVENT_CATEGORY = {
	Started: 'started',
	Signal: 'signal',
	Query: 'query',
	Update: 'update',
	Timer: 'timer',
	Activity: 'activity',
	Child: 'child',
	Compensation: 'compensation',
	Completed: 'completed',
	Failed: 'failed',
	Terminated: 'terminated',
	Worker: 'worker'
} as const;

/** Union of all event category strings. */
export type WorkflowEventCategory =
	(typeof WORKFLOW_EVENT_CATEGORY)[keyof typeof WORKFLOW_EVENT_CATEGORY];

/**
 * A single entry on the workflow event rail.
 * Each event has a monotonically increasing sequence number so the UI can
 * detect gaps and order events deterministically regardless of arrival order.
 */
export type WorkflowEvent = {
	/** Monotonically increasing sequence number within a single workflow run. */
	sequence: number;
	/** Raw Temporal event type string (e.g. "WorkflowExecutionStarted"). */
	type: string;
	/** ISO-8601 timestamp from the Temporal history entry. */
	timestamp: string;
	/** Workflow ID, present for all events except bare worker lifecycle events. */
	workflowId?: string;
	/** Arbitrary event-specific payload. Track D narrows this per event type. */
	payload?: unknown;
};
