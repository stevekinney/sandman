/**
 * session-restore.ts — re-attaching a reloaded page to a live workflow.
 *
 * The workflow run is never persisted client-side, so a fresh SessionState
 * knows nothing about a workflow started before a reload: `run` is null, the
 * timeline poll never fires, and restored tour progress would point at a run
 * the client cannot act on. This module re-derives the run from the sandbox
 * (Temporal Visibility, served by the server — no worker needed) and floors
 * the tour against the real workflow phase so the two can never disagree.
 */
import type {
	OrderInput,
	TimelineEntry,
	VisibilityWorkflowSummary
} from '$lib/contracts/workflow-api';
import { ORDER_FOOD_WORKFLOW, ORDER_STATUS } from '$lib/contracts/workflow-api';
import { TOUR } from '$lib/content/demo-script';
import type { TemporalController, WorkflowRun } from './types.ts';
import { buildDemoOrder, type SessionPhase } from './session-actions.ts';

/**
 * The slice of SessionState that restoration touches. Structural on purpose:
 * it documents exactly what restore mutates and keeps this module free of a
 * runtime dependency on the reactive class.
 */
export type RestorableSession = {
	run: WorkflowRun | null;
	activeOrder: OrderInput | null;
	readonly phase: SessionPhase;
	readonly tour: {
		readonly currentStepIndex: number;
		readonly isComplete: boolean;
		reset(): void;
	};
	ingestTimeline(entries: TimelineEntry[]): void;
};

/**
 * Whether a Visibility summary is a live order workflow the session can
 * re-attach to after a reload. Delivery children and finished runs are
 * excluded — only a running `orderFoodWorkflow` is resumable.
 * Status is compared case-insensitively because the Temporal CLI has emitted
 * both `WORKFLOW_EXECUTION_STATUS_RUNNING` (normalized to `RUNNING`) and
 * `Running` across versions.
 */
export function isResumableOrderWorkflow(summary: VisibilityWorkflowSummary): boolean {
	return summary.type === ORDER_FOOD_WORKFLOW && summary.status.toUpperCase() === 'RUNNING';
}

/** Resolve a tour step id to its index, failing loudly if the script drifts. */
function tourStepIndex(id: string): number {
	const index = TOUR.findIndex((step) => step.id === id);
	if (index === -1) throw new Error(`Unknown tour step id: ${id}`);
	return index;
}

/**
 * The earliest tour step consistent with an observed order phase.
 *
 * Replayed timeline events advance most steps on their own; this floor covers
 * what replay cannot: restored progress parked on a step the phase has made
 * impossible (the update validator rejects address changes once the order is
 * in delivery) and steps whose completing event necessarily already happened.
 * Forward-only by design — feed it to `TourState.advanceTo`, which ignores
 * targets at or behind the current step.
 */
export function minimumTourStepIndexForPhase(phase: SessionPhase): number {
	switch (phase) {
		case 'idle':
			return 0;
		case ORDER_STATUS.Created:
		case ORDER_STATUS.Validating:
			// A run exists, so "place an order" is behind us.
			return tourStepIndex('activities-run');
		case ORDER_STATUS.AwaitingRestaurant:
			// Activities completed and the deadline timer started on the way here.
			return tourStepIndex('signal-accept');
		case ORDER_STATUS.Preparing:
		case ORDER_STATUS.AwaitingCourier:
			// The restaurant signal was received; the update lesson is still open.
			return tourStepIndex('update-with-validator');
		case ORDER_STATUS.InDelivery:
			// The delivery child has started, and the update validator now rejects
			// address changes — that step can never complete from here.
			return tourStepIndex('queryable-business-snapshot');
		case ORDER_STATUS.Delivered:
			return TOUR.length;
		case ORDER_STATUS.Cancelled:
		case ORDER_STATUS.Refunded:
			// A cancelled order teaches nothing further — leave the tour alone;
			// the learner resets to go again.
			return 0;
	}
	const exhaustive: never = phase;
	return exhaustive;
}

/** Sessions that already attempted restoration — restore runs at most once. */
const restoreAttempted = new WeakSet<RestorableSession>();

/**
 * Restore a reloaded session from the sandbox's current workflow.
 *
 * Queries Temporal Visibility for a running order workflow, adopts its ids,
 * rebuilds the canned demo order (the workflow id is the order id), and
 * replays `getTimeline` so the tour reconciles against the real phase. If the
 * timeline query fails (worker down), the regular poll catches up once the
 * worker returns.
 *
 * When no order workflow is running, stale in-progress tour state is reset so
 * the journey starts cleanly — a finished tour keeps its completed state.
 * Runs at most once per session; a Visibility failure clears the attempt so a
 * later server recovery can retry.
 */
export async function restoreSessionFromSandbox(
	controller: TemporalController,
	session: RestorableSession
): Promise<void> {
	if (restoreAttempted.has(session) || session.run !== null) return;
	restoreAttempted.add(session);

	let workflows: VisibilityWorkflowSummary[];
	try {
		workflows = await controller.visibility({});
	} catch {
		restoreAttempted.delete(session);
		return;
	}
	// The learner may have placed a new order while the lookup was in flight.
	if (session.run !== null) return;

	const active = workflows.find(isResumableOrderWorkflow);
	if (active === undefined) {
		if (!session.tour.isComplete && session.tour.currentStepIndex > 0) session.tour.reset();
		return;
	}

	session.run = { workflowId: active.workflowId, runId: active.runId };
	session.activeOrder = buildDemoOrder(active.workflowId);
	try {
		const entries = await controller.query(active.workflowId, 'getTimeline');
		// The learner may have Reset and placed a different order while this
		// query was in flight — only apply the timeline if it still belongs to
		// the run we're restoring, or it would corrupt the new run's state.
		if (Array.isArray(entries) && session.run?.workflowId === active.workflowId) {
			session.ingestTimeline(entries);
		}
	} catch {
		// Worker offline — the timeline poll replays history after it restarts.
	}
}
