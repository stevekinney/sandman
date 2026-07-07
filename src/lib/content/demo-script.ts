/**
 * demo-script.ts — authoritative data for the teaching layer.
 *
 * Exports:
 *   FEATURE_MAP  — one entry per FeatureId, with concept, oneLiner, and mechanic.
 *   SIGNAL_FEATURE / QUERY_FEATURE / CONTROL_FEATURE
 *                — drift-proof Record types: TypeScript errors if the contract
 *                  gains a new signal/query/control without this file being updated.
 *   SCENARIO_COPY — plain-English scenario copy keyed by OrderStatus.
 *   TOUR         — ordered guided-tour steps with event-driven completion predicates.
 */

import type { ControlId, FeatureId, QueryName, SignalName } from '$lib/contracts/workflow-api';
import { ORDER_STATUS, WORKFLOW_EVENT_TYPE } from '$lib/contracts/workflow-api';
import type { OrderStatus } from '$lib/contracts/workflow-api';
import type { WorkflowEvent } from '$lib/contracts/events';

// ---------------------------------------------------------------------------
// FeatureEntry — extends the contract's Feature with an oneLiner field
// ---------------------------------------------------------------------------

/** An entry in the feature map, adding a short one-liner for callout display. */
export type FeatureEntry = {
	/** Stable identifier, mirrors FeatureId in the contract. */
	id: FeatureId;
	/** Temporal concept name rendered as a heading. */
	concept: string;
	/** One sentence — shown in concept-annotation callouts when a control is triggered. */
	oneLiner: string;
	/** Detailed mechanic — shown in the feature legend. */
	mechanic: string;
	/** Optional control that demonstrates this feature. */
	control?: ControlId;
	/** Optional signal that exercises this feature. */
	signal?: SignalName;
	/** Optional query that exercises this feature. */
	query?: QueryName;
};

/**
 * Complete feature map keyed by FeatureId.
 * TypeScript forces every FeatureId to appear as a key — add a new FeatureId
 * to the contract and this object will not compile until you wire it in.
 * Explicit Record type (not `as const`) so Object.values() returns FeatureEntry[].
 */
export const FEATURE_MAP: Record<FeatureId, FeatureEntry> = {
	'activities-retry': {
		id: 'activities-retry',
		concept: 'Activities & Automatic Retry',
		oneLiner:
			'Activities are the durable units of work; Temporal retries them automatically on failure.',
		mechanic:
			'The payment charge runs as an activity with a visible retry policy. Card 0000 fails its first attempt with a fake gateway timeout, and Temporal retries it automatically with exponential backoff — the workflow contains no retry loop.',
		control: 'start-order'
	},
	'non-retryable-failure': {
		id: 'non-retryable-failure',
		concept: 'Non-Retryable Failures',
		oneLiner:
			'Some errors should never be retried — mark them nonRetryable to skip the retry policy entirely.',
		mechanic:
			'Card 9999 is declined by the issuer. A decline is permanent, so the activity throws ApplicationFailure with nonRetryable: true — the retry policy is skipped and the workflow cancels the order instead.',
		control: 'start-order'
	},
	signals: {
		id: 'signals',
		concept: 'Signals',
		oneLiner: 'Signals let external systems push events into a running workflow without polling.',
		mechanic:
			'Restaurant acceptance, delivery completion, and cancellation are Temporal signals — async messages into the running workflow. The workflow parks on condition() and resumes the moment the signal it is waiting for arrives.',
		control: 'accept-restaurant',
		signal: 'restaurantAccepted'
	},
	queries: {
		id: 'queries',
		concept: 'Queries',
		oneLiner:
			'Queries read workflow state synchronously — no events emitted, no execution advanced.',
		mechanic:
			'getStatus returns a live OrderSnapshot — status, total, payment attempts, and the order timeline — without advancing execution or writing history.',
		control: 'query-status',
		query: 'getStatus'
	},
	'timers-durable-sleep': {
		id: 'timers-durable-sleep',
		concept: 'Durable Timers',
		oneLiner:
			'Timers live in the Temporal server, not in your process — they survive worker restarts.',
		mechanic:
			'A deadline timer fires if the restaurant does not accept in time, automatically refunding the payment. The timer lives in the Temporal server, not the worker — it survives worker restarts.',
		control: 'start-order'
	},
	'durable-recovery': {
		id: 'durable-recovery',
		concept: 'Durable Recovery',
		oneLiner:
			'Killing the worker process proves the point: Temporal preserves all workflow state and resumes execution exactly where it left off.',
		mechanic:
			'The kill-worker button terminates the Node.js worker process mid-flight. Because the Temporal server preserves all workflow state, the workflow resumes exactly where it left off when the worker restarts — the centrepiece of the Sandman demo.',
		control: 'kill-worker'
	}
};

// ---------------------------------------------------------------------------
// Drift-proof association maps
// TypeScript enforces every union member appears as a key.
// ---------------------------------------------------------------------------

/**
 * Maps every SignalName to the primary FeatureId it demonstrates.
 * Adding a signal to the contract without updating this causes a compile error.
 */
export const SIGNAL_FEATURE: Record<SignalName, FeatureId> = {
	restaurantAccepted: 'signals',
	deliveryCompleted: 'signals',
	cancelOrder: 'signals'
};

/**
 * Maps every QueryName to the primary FeatureId it demonstrates.
 * Adding a query to the contract without updating this causes a compile error.
 */
export const QUERY_FEATURE: Record<QueryName, FeatureId> = {
	getStatus: 'queries'
};

/**
 * Maps every ControlId to the primary FeatureId it demonstrates.
 * Adding a control to the contract without updating this causes a compile error.
 */
export const CONTROL_FEATURE: Record<ControlId, FeatureId> = {
	'start-order': 'activities-retry',
	'accept-restaurant': 'signals',
	'complete-delivery': 'signals',
	'cancel-order': 'signals',
	'query-status': 'queries',
	'kill-worker': 'durable-recovery'
};

// ---------------------------------------------------------------------------
// Scenario copy — plain-English description per OrderStatus
// TypeScript forces all ORDER_STATUS values to be covered.
// ---------------------------------------------------------------------------

/**
 * Plain-English scenario description for each order lifecycle state.
 * Rendered by the Scenario Panel when the workflow is in a given status.
 */
export const SCENARIO_COPY: Record<OrderStatus, string> = {
	[ORDER_STATUS.Received]:
		'The order has been placed. The workflow is charging the card — an activity that Temporal retries automatically if it fails.',
	[ORDER_STATUS.WaitingForRestaurant]:
		'Payment succeeded. The workflow is parked on a condition(), waiting for the restaurant to accept. A durable timer will refund the payment if no acceptance arrives in time.',
	[ORDER_STATUS.Preparing]:
		'The restaurant accepted and is cooking. The workflow is waiting for the deliveryCompleted signal — this wait can last hours and survives worker crashes.',
	[ORDER_STATUS.Delivered]:
		'The order has been delivered. The workflow has reached a terminal completed state.',
	[ORDER_STATUS.Cancelled]:
		'The order was cancelled. If the card had already been charged, the workflow refunded it before finishing.',
	[ORDER_STATUS.Refunded]:
		'The restaurant never accepted, so the durable timer fired and the workflow refunded the payment automatically before finishing.'
};

// ---------------------------------------------------------------------------
// Tour step type
// ---------------------------------------------------------------------------

/**
 * A hands-on code experiment attached to a tour step: a concrete edit the
 * learner can make in the sandbox editor to get a different outcome. The
 * anchor is a verbatim substring of the named sandbox-template file (the
 * anti-drift test asserts this) so "show me the code" can jump straight to it.
 */
export type TourExperiment = {
	/** What to change and what will happen — rendered as Markdown. */
	prompt: string;
	/** Which editable sandbox file the code lives in. */
	file: string;
	/** Verbatim substring of that file to reveal in the editor. */
	anchor: string;
};

/**
 * A "where to look" callout attached to a tour step: a note (rendered as
 * Markdown) about what a workbench surface is showing right now, plus the
 * surface itself so the UI can navigate the learner straight to it.
 */
export type TourLookAt = {
	/** Which surface to bring into view. */
	surface: 'temporal-ui' | 'events' | 'steps';
	/** Why it is worth looking — teaches what the surface shows. */
	note: string;
};

/** A single step in the guided tour. */
export type TourStep = {
	/** Stable identifier for this step. */
	id: string;
	/** Temporal concept eyebrow rendered above the step title (e.g. "Signals"). */
	concept: string;
	/** Short title rendered in the step indicator. */
	title: string;
	/** Full instructional copy rendered below the title. */
	instruction: string;
	/** One line telling the learner what to watch for while the step completes. */
	watch: string;
	/** Optional hands-on code edit that produces a different outcome. */
	experiment?: TourExperiment;
	/** Optional "where to look" callout that navigates to a workbench surface. */
	lookAt?: TourLookAt;
	/** Optional control-plane action that drives this step. */
	control?: ControlId;
	/**
	 * Pure predicate: returns true when the given workflow event should
	 * advance this step to completion.
	 * The engine evaluates this ONLY for the current step — earlier events
	 * cannot prematurely advance later steps.
	 */
	completes: (e: WorkflowEvent) => boolean;
};

// ---------------------------------------------------------------------------
// TOUR — ordered guided-tour steps
// ---------------------------------------------------------------------------

/**
 * Ordered list of guided-tour steps.
 * Each step advances only when its `completes` predicate matches an incoming
 * WorkflowEvent — progress is event-driven, not click-driven.
 * The durable-recovery step completes ONLY on a WorkerRestarted event.
 */
export const TOUR: readonly TourStep[] = [
	{
		id: 'start-workflow',
		concept: 'Durable execution',
		title: 'Place a food order',
		instruction:
			'Start one durable order workflow. Temporal records the start event in history, then a worker begins running your workflow code.',
		watch: 'The first history event lands in the workflow history rail.',
		control: 'start-order',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionStarted
	},
	{
		id: 'activities-run',
		concept: 'Activities & retries',
		title: 'An activity runs — with automatic retries',
		instruction:
			'The payment charge runs as an activity. If a transient failure occurs, Temporal retries automatically with exponential backoff. You do not write retry loops.',
		watch: 'Activity tasks complete in the event stream — retries happen on their own.',
		experiment: {
			prompt:
				"Make the charge fail once: in `activities.ts`, `chargePayment` simulates a gateway timeout for card `'0000'` — change it to `'4242'` (the default demo card), then Reset and place a new order. Attempt 1 fails and Temporal retries it for you.",
			file: 'activities.ts',
			anchor: "cardLast4 === '0000'"
		},
		lookAt: {
			surface: 'events',
			note: 'The **Events** lens on the right streams the durable history as it is written — every activity, retry, timer, and signal, live.'
		},
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.ActivityTaskCompleted
	},
	{
		id: 'durable-timer',
		concept: 'Durable timers',
		title: 'A durable timer guards the deadline',
		instruction:
			'The workflow starts a timer for the restaurant-acceptance deadline. This timer lives in the Temporal server — it will fire even if the worker crashes and restarts.',
		watch: 'A TimerStarted event is recorded in history.',
		experiment: {
			prompt:
				'Shrink the deadline: change the `?? 300` second fallback in `workflow.ts` to `?? 30`, save, then Reset and place a new order without accepting it. Thirty seconds later the durable timer fires and the payment is refunded.',
			file: 'workflow.ts',
			anchor: 'input.restaurantTimeoutSeconds ?? 300'
		},
		lookAt: {
			surface: 'temporal-ui',
			note: 'This is the **real Temporal Web UI**, proxied from your sandbox. Your order is in the Workflows list — open it to see its Event History and the pending timer the server is holding durably.'
		},
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.TimerStarted
	},
	{
		id: 'signal-accept',
		concept: 'Signals',
		title: 'Send a signal to resume',
		instruction:
			'The order is parked waiting for the restaurant. Sending the restaurant-accepted signal appends an event to history and resumes the workflow.',
		watch: '"Awaiting restaurant" flips to preparing.',
		control: 'accept-restaurant',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionSignaled
	},
	{
		id: 'query-status',
		concept: 'Queries',
		title: 'Read state with a query',
		instruction:
			'Ask the running workflow for its current order snapshot. Queries are read-only: they inspect state without moving the workflow forward.',
		watch: 'A snapshot returns; no new history event is written.',
		lookAt: {
			surface: 'steps',
			note: 'Flip the right rail to **Steps**: the same durable history, translated to plain language. Compare it with the raw **Events** lens to see exactly what Temporal stores.'
		},
		control: 'query-status',
		completes: (e) => e.type === 'QueryCompleted'
	},
	{
		id: 'durable-recovery',
		concept: 'Durable recovery',
		title: 'Kill the worker — watch it recover',
		instruction:
			'Kill the process running your workflow code. State lives in the Temporal server, so after you restart the worker it replays history and resumes exactly where it left off.',
		watch: 'The worker goes dark, then recovers with nothing lost.',
		lookAt: {
			surface: 'temporal-ui',
			note: 'After the restart, open your workflow in the Temporal UI: the Event History shows the worker vanish, then a fresh one **replay every recorded event** to rebuild state — nothing was lost.'
		},
		control: 'kill-worker',
		// Completes ONLY on WorkerRestarted — WorkerKilled does not advance this step.
		completes: (e) => e.type === 'WorkerRestarted'
	},
	{
		id: 'complete-delivery',
		concept: 'Completion',
		title: 'Finish the delivery',
		instruction:
			'Send the delivery-completed signal. The workflow resumes from its final wait, records the delivery, and returns its result.',
		watch: 'The run reaches its final state.',
		control: 'complete-delivery',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
	}
];
