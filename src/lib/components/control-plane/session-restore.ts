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
	OrderStatus,
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
	/** Bumped by `reset()` — lets an in-flight restore detect a mid-flight Reset. */
	readonly resetEpoch: number;
	/** Called synchronously right after `run` changes — see SessionState.onRunChanged. */
	onRunChanged: (run: WorkflowRun | null) => void;
	readonly tour: {
		readonly currentStepIndex: number;
		readonly isComplete: boolean;
		advanceTo(index: number): void;
		reset(): void;
	};
	ingestTimeline(entries: TimelineEntry[]): void;
};

/**
 * Whether a Visibility summary is the sandbox's order workflow — the parent
 * `orderFoodWorkflow`, not a `delivery-…` child — regardless of whether it is
 * still running. Used to find anything worth reconciling tour progress
 * against, including a run that finished (Delivered/Cancelled/Refunded)
 * moments before a reload raced the final `getTimeline` poll that would have
 * recorded it — that history is still real and worth replaying, not a reason
 * to wipe the learner's progress back to step 0.
 */
export function isOrderWorkflowSummary(summary: VisibilityWorkflowSummary): boolean {
	return summary.type === ORDER_FOOD_WORKFLOW;
}

/**
 * Whether a Visibility summary is a *live* order workflow — the same check as
 * {@link isOrderWorkflowSummary}, plus still running. Used to prefer an
 * active run over a stale finished one when both are present and no
 * `preferredWorkflowId` disambiguates.
 * Status is compared case-insensitively because the Temporal CLI has emitted
 * both `WORKFLOW_EXECUTION_STATUS_RUNNING` (normalized to `RUNNING`) and
 * `Running` across versions.
 */
export function isResumableOrderWorkflow(summary: VisibilityWorkflowSummary): boolean {
	return isOrderWorkflowSummary(summary) && summary.status.toUpperCase() === 'RUNNING';
}

/** Resolve a tour step id to its index, failing loudly if the script drifts. */
function tourStepIndex(id: string): number {
	const index = TOUR.findIndex((step) => step.id === id);
	if (index === -1) throw new Error(`Unknown tour step id: ${id}`);
	return index;
}

const KNOWN_ORDER_STATUSES: readonly string[] = Object.values(ORDER_STATUS);

/** Narrow a Visibility summary's indexed OrderStatus search attribute, if present. */
function knownOrderStatus(value: string | undefined): OrderStatus | undefined {
	return value !== undefined && KNOWN_ORDER_STATUSES.includes(value)
		? (value as OrderStatus)
		: undefined;
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
		case ORDER_STATUS.Delivered:
			// The delivery child has started, and the update validator now rejects
			// address changes — that step can never complete from here. Nothing
			// further (a Visibility query, a worker kill/restart, the completion
			// observation) is implied merely by reaching either phase — including
			// Delivered: the run can finish without the worker ever having been
			// killed. Leave those later steps to real replayed events, or to
			// `stepStuckAtTerminal`/`skip()` once the phase is terminal and no
			// more events can arrive — don't silently mark them complete here.
			return tourStepIndex('queryable-business-snapshot');
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
 * Consecutive "no resumable workflow found" results per session. Temporal
 * Visibility is eventually consistent, so a workflow started moments before a
 * reload can briefly be absent from the list — this tolerates that lag before
 * concluding there really is no workflow to restore.
 */
const notFoundStreak = new WeakMap<RestorableSession, number>();

/** Consecutive empty results required before treating "not found" as final. */
const NOT_FOUND_CONFIRMATION_ROUNDS = 3;

/**
 * Restore a reloaded session from the sandbox's current workflow.
 *
 * Queries Temporal Visibility for a running order workflow, adopts its ids,
 * rebuilds the canned demo order (the workflow id is the order id), floors
 * the tour to at least the phase the adopted run implies, and replays
 * `getTimeline` so the tour can reconcile further against the real phase. If
 * the timeline query fails (worker down), the regular poll catches up once
 * the worker returns — the initial floor still applies so the tour isn't
 * stuck asking for an action a run already makes impossible.
 *
 * `preferredWorkflowId`, when supplied, disambiguates when Visibility returns
 * more than one resumable order workflow (e.g. the learner used Reset — which
 * is client-only and does not cancel the run — then placed another order):
 * the summary matching it wins over an arbitrary first match.
 *
 * `dismissedWorkflowId`, when supplied, excludes that specific workflow from
 * consideration entirely — set to whatever the learner most recently Reset
 * away from, so a reload right after Reset doesn't silently reattach to the
 * exact still-running order the learner just walked away from (Reset is
 * client-only and does not cancel it server-side).
 *
 * When no order workflow is running, stale in-progress tour state is reset so
 * the journey starts cleanly — a finished tour keeps its completed state.
 * Because Visibility is eventually consistent, "not found" is only treated as
 * final after `NOT_FOUND_CONFIRMATION_ROUNDS` consecutive empty results;
 * until then the attempt flag is cleared for the caller's next retry, exactly
 * like a Visibility error.
 *
 * Runs at most once per session (once it finds and adopts a run, or confirms
 * none exists, or discovers the learner already has a live run of their own);
 * a Visibility failure or an unconfirmed empty result clears the attempt so
 * the caller's regular polling cadence can retry. A Reset mid-flight abandons
 * this attempt the same way — the next poll tick starts fresh and, if the
 * workflow is still running server-side, re-attaches to it exactly as it
 * would without the race (Reset is client-only and does not cancel the run —
 * see the module doc).
 *
 * Once a session has ever reached this point with a run already set — whether
 * because it adopted one itself or because the learner placed an order before
 * this ever got to run — restoration is permanently done for that session
 * instance. Without this, a learner who orders fast enough that `run` is
 * already non-null on entry would leave `restoreAttempted` unset; a later
 * Reset (which does not cancel the still-running workflow server-side) would
 * then let the next poll tick re-run restoration from scratch and silently
 * re-adopt that old run, undoing the Reset the learner just performed.
 */
export async function restoreSessionFromSandbox(
	controller: TemporalController,
	session: RestorableSession,
	preferredWorkflowId?: string,
	dismissedWorkflowId?: string
): Promise<void> {
	if (restoreAttempted.has(session)) return;
	if (session.run !== null) {
		restoreAttempted.add(session);
		return;
	}
	restoreAttempted.add(session);
	const epochAtStart = session.resetEpoch;

	let workflows: VisibilityWorkflowSummary[];
	try {
		workflows = await controller.visibility({});
	} catch {
		restoreAttempted.delete(session);
		// An error is not an observation — it must not silently count towards
		// (or survive alongside) a run of confirmed-empty results. Without
		// this, two empty results followed by a transient error followed by
		// one more empty result would hit NOT_FOUND_CONFIRMATION_ROUNDS on
		// that third empty result, even though the sequence was interrupted
		// and nothing was actually confirmed for certain in between.
		notFoundStreak.delete(session);
		return;
	}
	// The learner may have placed a new order, or hit Reset (which doesn't
	// change `run` if it was already null), while the lookup was in flight.
	if (session.run !== null) return;
	if (session.resetEpoch !== epochAtStart) {
		restoreAttempted.delete(session);
		return;
	}

	// Any order workflow (running or finished) is worth reconciling against,
	// except the one the learner explicitly Reset away from; prefer an exact
	// match, then a live run, then whatever's left — a stale finished order is
	// still better to replay than to silently discard.
	const orderWorkflows = workflows
		.filter(isOrderWorkflowSummary)
		.filter((summary) => summary.workflowId !== dismissedWorkflowId);
	const active =
		orderWorkflows.find((summary) => summary.workflowId === preferredWorkflowId) ??
		orderWorkflows.find(isResumableOrderWorkflow) ??
		orderWorkflows[0];

	if (active === undefined) {
		const streak = (notFoundStreak.get(session) ?? 0) + 1;
		if (streak < NOT_FOUND_CONFIRMATION_ROUNDS) {
			notFoundStreak.set(session, streak);
			restoreAttempted.delete(session);
			return;
		}
		notFoundStreak.delete(session);
		if (!session.tour.isComplete && session.tour.currentStepIndex > 0) session.tour.reset();
		return;
	}
	notFoundStreak.delete(session);

	session.run = { workflowId: active.workflowId, runId: active.runId };
	session.onRunChanged(session.run);
	session.activeOrder = buildDemoOrder(active.workflowId);
	// Visibility's indexed OrderStatus search attribute is real and available
	// even with the worker down — unlike `session.phase`, which reads Created
	// until getTimeline supplies real entries. Floor the tour with it right
	// away so a further-along order (e.g. AwaitingRestaurant) isn't floored as
	// if it had only just started. Falls back to `session.phase` if the
	// attribute is unavailable (Search Attributes weren't registered).
	const knownPhase = knownOrderStatus(active.businessSnapshot.OrderStatus);
	session.tour.advanceTo(minimumTourStepIndexForPhase(knownPhase ?? session.phase));
	try {
		const entries = await controller.query(active.workflowId, 'getTimeline');
		// The learner may have Reset and placed a different order while this
		// query was in flight — only apply the timeline if it still belongs to
		// the run we're restoring, or it would corrupt the new run's state.
		if (Array.isArray(entries) && session.run?.workflowId === active.workflowId) {
			session.ingestTimeline(entries);
		}
	} catch {
		// Worker offline. The tour floor above already accounts for the real
		// phase, but `session.phase` itself (which every `canDo()` gate reads —
		// e.g. accepting an AwaitingRestaurant order is a signal that doesn't
		// need the worker) would otherwise stay stuck at Created until the
		// worker returns. Seed it from the same known phase via a synthetic,
		// eventType-less entry: `ingestTimeline` never feeds it as an event (so
		// it can't be mistaken for real history or duplicate-fed), but
		// `derivePhase` reads its `status` until the real timeline poll
		// replaces this array wholesale once the worker recovers.
		if (knownPhase !== undefined) {
			session.ingestTimeline([
				{
					index: -1,
					timestamp: new Date(0).toISOString(),
					description: 'Seeded from Visibility while the worker is offline.',
					status: knownPhase
				}
			]);
		}
	}
}
