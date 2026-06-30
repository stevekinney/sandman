/**
 * demo-script.ts — authoritative data for the Track F teaching layer.
 *
 * Exports:
 *   FEATURE_MAP  — one entry per FeatureId, with concept, oneLiner, and mechanic.
 *   SIGNAL_FEATURE / QUERY_FEATURE / UPDATE_FEATURE / CONTROL_FEATURE
 *                — drift-proof Record types: TypeScript errors if the contract
 *                  gains a new signal/query/update/control without this file being updated.
 *   SCENARIO_COPY — plain-English scenario copy keyed by OrderStatus.
 *   TOUR         — ordered guided-tour steps with event-driven completion predicates.
 */

import type {
	ControlId,
	FeatureId,
	QueryName,
	SignalName,
	UpdateName
} from '$lib/contracts/workflow-api';
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
	/** Optional update that exercises this feature. */
	update?: UpdateName;
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
			'Payment charge, restaurant notification, and courier dispatch each run as activities with configurable retry policies. Transient failures are automatically retried with exponential backoff.',
		control: 'start-order'
	},
	'non-retryable-failure': {
		id: 'non-retryable-failure',
		concept: 'Non-Retryable Failures',
		oneLiner:
			'Some errors should never be retried — mark them nonRetryable to skip the retry policy entirely.',
		mechanic:
			'An invalid payment method or out-of-area address throws ApplicationFailure with nonRetryable: true, bypassing the retry policy and immediately triggering the saga compensation path.',
		control: 'start-order'
	},
	'saga-compensation': {
		id: 'saga-compensation',
		concept: 'Saga / Compensation',
		oneLiner:
			'A saga records compensating actions as it goes, so rollback is always the exact inverse of the forward path.',
		mechanic:
			'If the workflow fails after charging the customer, a compensation stack issues a refund. Each forward step registers a compensating action so the rollback is always symmetric.',
		control: 'cancel-order',
		signal: 'cancelOrder'
	},
	signals: {
		id: 'signals',
		concept: 'Signals',
		oneLiner: 'Signals let external systems push events into a running workflow without polling.',
		mechanic:
			'Restaurant acceptance, rejection, food-ready, courier location, tip, and order cancellation all use Temporal signals. The workflow blocks on signal receipt using condition(), resuming only when the expected signal arrives.',
		control: 'accept-restaurant',
		signal: 'restaurantAccepted'
	},
	queries: {
		id: 'queries',
		concept: 'Queries',
		oneLiner:
			'Queries read workflow state synchronously — no events emitted, no execution advanced.',
		mechanic:
			'getStatus returns a live OrderSnapshot of all workflow state without advancing execution. getTimeline returns the annotated event log consumed by the guided-tour panel.',
		control: 'query-status',
		query: 'getStatus'
	},
	'updates-validators': {
		id: 'updates-validators',
		concept: 'Updates with Validators',
		oneLiner:
			'Updates combine a synchronous validator (reject immediately) with a handler that mutates workflow state.',
		mechanic:
			'updateDeliveryAddress is rejected synchronously by a validator if the order is already in delivery. applyPromoCode validates the code before mutating state, returning a typed rejection to the caller without re-driving the workflow.',
		control: 'update-address',
		update: 'updateDeliveryAddress'
	},
	'timers-durable-sleep': {
		id: 'timers-durable-sleep',
		concept: 'Durable Timers / sleep()',
		oneLiner:
			'Timers live in the Temporal server, not in your process — they survive worker restarts.',
		mechanic:
			'A configurable deadline timer fires if the restaurant does not accept within N minutes, automatically triggering cancellation and saga compensation. The timer survives worker restarts.',
		control: 'start-order'
	},
	'child-workflow': {
		id: 'child-workflow',
		concept: 'Child Workflows',
		oneLiner:
			'Child workflows let you decompose complex orchestrations into independently observable units.',
		mechanic:
			'Once a courier is assigned, the delivery leg is handed off to a DeliveryWorkflow child workflow. Its lifecycle is independently visible in the Temporal Web UI, demonstrating workflow composition.',
		control: 'food-ready',
		signal: 'foodReady'
	},
	'heartbeats-cancellation': {
		id: 'heartbeats-cancellation',
		concept: 'Activity Heartbeats & Cancellation',
		oneLiner:
			'Heartbeats let a long-running activity prove it is alive — and receive cancellation signals without polling.',
		mechanic:
			'The courier-tracking activity heartbeats every 5 seconds with its latest location. Cancelling the order propagates cancellation to the activity via the heartbeat token, allowing a clean shutdown.',
		control: 'kill-worker',
		signal: 'courierLocationUpdate'
	},
	'continue-as-new': {
		id: 'continue-as-new',
		concept: 'ContinueAsNew',
		oneLiner:
			"ContinueAsNew truncates a long-running workflow's event history by starting a fresh run with the same state.",
		mechanic:
			'After 100 courier location updates, the workflow calls continueAsNew to keep event history bounded. The new run receives the current OrderSnapshot as its seed state so no data is lost.',
		signal: 'courierLocationUpdate'
	},
	'queryable-business-snapshot': {
		id: 'queryable-business-snapshot',
		concept: 'Queryable Business Snapshot',
		oneLiner:
			'The workflow query returns business dimensions before you introduce indexed Visibility.',
		mechanic:
			'getStatus returns OrderStatus, CustomerTier, and RestaurantId in businessSnapshot. This gives learners a simple read model before the advanced Search Attributes scenario.',
		control: 'query-status',
		query: 'getStatus'
	},
	'search-attributes': {
		id: 'search-attributes',
		concept: 'Temporal Search Attributes',
		oneLiner:
			'Search Attributes index workflow executions so Temporal Web and list APIs can filter across runs.',
		mechanic:
			'The advanced Visibility scenario upserts OrderStatus, CustomerTier, and RestaurantId as real Temporal Search Attributes and lists matching executions through Temporal Visibility.',
		control: 'list-visibility',
		query: 'getStatus'
	},
	'local-activities': {
		id: 'local-activities',
		concept: 'Local Activities',
		oneLiner:
			'Local activities execute in the same worker process — no round-trip to the Temporal server — trading some durability for lower latency.',
		mechanic:
			'Audit-log writes and metrics emission run as local activities (executed in the same process, no round-trip to the Temporal server) to demonstrate the durability/performance trade-off.',
		control: 'start-order'
	},
	'replay-safety': {
		id: 'replay-safety',
		concept: 'Replay Safety',
		oneLiner:
			'Workflow code must be deterministic — all non-deterministic work belongs in activities, not the workflow function itself.',
		mechanic:
			'All non-deterministic operations (random IDs, current time, external HTTP calls) are wrapped in activities. The workflow function itself is a pure deterministic function of its history, as verified by the replayer.',
		query: 'getTimeline'
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
	cancelOrder: 'saga-compensation',
	restaurantAccepted: 'signals',
	restaurantRejected: 'signals',
	foodReady: 'child-workflow',
	courierLocationUpdate: 'heartbeats-cancellation',
	addTip: 'signals',
	deliveryCompleted: 'child-workflow'
};

/**
 * Maps every QueryName to the primary FeatureId it demonstrates.
 * Adding a query to the contract without updating this causes a compile error.
 */
export const QUERY_FEATURE: Record<QueryName, FeatureId> = {
	getStatus: 'queries',
	getTimeline: 'replay-safety'
};

/**
 * Maps every UpdateName to the primary FeatureId it demonstrates.
 * Adding an update to the contract without updating this causes a compile error.
 */
export const UPDATE_FEATURE: Record<UpdateName, FeatureId> = {
	updateDeliveryAddress: 'updates-validators',
	applyPromoCode: 'updates-validators'
};

/**
 * Maps every ControlId to the primary FeatureId it demonstrates.
 * Adding a control to the contract without updating this causes a compile error.
 */
export const CONTROL_FEATURE: Record<ControlId, FeatureId> = {
	'start-order': 'activities-retry',
	'cancel-order': 'saga-compensation',
	'accept-restaurant': 'signals',
	'reject-restaurant': 'signals',
	'food-ready': 'child-workflow',
	'update-location': 'heartbeats-cancellation',
	'add-tip': 'signals',
	'update-address': 'updates-validators',
	'apply-promo': 'updates-validators',
	'complete-delivery': 'child-workflow',
	'kill-worker': 'durable-recovery',
	'list-visibility': 'search-attributes',
	'query-status': 'queries',
	'query-timeline': 'replay-safety'
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
	[ORDER_STATUS.Created]:
		'The order has been placed. The workflow is validating the request and charging the payment method.',
	[ORDER_STATUS.Validating]:
		'The order details are being validated. If the payment method or address is invalid, a non-retryable failure triggers saga compensation immediately.',
	[ORDER_STATUS.AwaitingRestaurant]:
		'A notification was sent to the restaurant. The workflow is now blocking on a condition(), waiting for the restaurant to accept or reject. A durable timer will fire if no response arrives within the deadline.',
	[ORDER_STATUS.Preparing]:
		'The restaurant accepted the order and is preparing the food. A child workflow will be started once the courier is assigned.',
	[ORDER_STATUS.AwaitingCourier]:
		'The food is ready. The workflow is waiting for a courier to be dispatched via the delivery child workflow.',
	[ORDER_STATUS.InDelivery]:
		'The courier has picked up the food. The tracking activity is heartbeating with location updates. ContinueAsNew will fire after 100 location updates to keep event history bounded.',
	[ORDER_STATUS.Delivered]:
		'The order has been delivered successfully. The workflow has reached a terminal completed state.',
	[ORDER_STATUS.Cancelled]:
		'The order was cancelled. The saga compensation stack is executing — any charges will be reversed and the restaurant will be notified.',
	[ORDER_STATUS.Refunded]:
		'The saga compensation completed successfully. The payment has been refunded and the workflow has reached a terminal state.'
};

// ---------------------------------------------------------------------------
// Tour step type
// ---------------------------------------------------------------------------

/** A single step in the guided tour. */
export type TourStep = {
	/** Stable identifier for this step. */
	id: string;
	/** Short title rendered in the step indicator. */
	title: string;
	/** Full instructional copy rendered below the title. */
	instruction: string;
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
		title: 'Place a food order',
		instruction:
			'Click "Start Order" to kick off the food-ordering workflow. A WorkflowExecution is created in the Temporal server and your workflow function begins running inside the worker process.',
		control: 'start-order',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionStarted
	},
	{
		id: 'activities-run',
		title: 'Activities run — watch automatic retry',
		instruction:
			'Payment charge, restaurant notification, and courier dispatch each run as activities. If a transient failure occurs, Temporal retries automatically with exponential backoff. You do not write retry loops.',
		control: 'start-order',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.ActivityTaskCompleted
	},
	{
		id: 'durable-timer',
		title: 'A durable timer guards the restaurant deadline',
		instruction:
			'The workflow starts a timer for the restaurant-acceptance deadline. This timer lives in the Temporal server — it will fire even if the worker crashes and restarts.',
		control: 'start-order',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.TimerStarted
	},
	{
		id: 'signal-accept',
		title: 'Send a signal to resume the workflow',
		instruction:
			'Click "Accept" to send a restaurantAccepted signal. The workflow has been blocking on condition() waiting for this signal. It now resumes and transitions to the Preparing state.',
		control: 'accept-restaurant',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionSignaled
	},
	{
		id: 'update-with-validator',
		title: 'Updates with synchronous validators',
		instruction:
			'Try updating the delivery address while the order is still preparing. The validator runs synchronously before the handler, so invalid updates are rejected before workflow execution is consumed.',
		control: 'update-address',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionUpdateAccepted
	},
	{
		id: 'child-workflow',
		title: 'A child workflow handles delivery',
		instruction:
			'Click "Food Ready" to hand the delivery leg off to a DeliveryWorkflow child. You can see it listed independently in the Temporal Web UI, demonstrating workflow composition.',
		control: 'food-ready',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.ChildWorkflowExecutionStarted
	},
	{
		id: 'queryable-business-snapshot',
		title: 'Read the queryable business snapshot',
		instruction:
			'Click "Get Status" to read the workflow snapshot, including OrderStatus, CustomerTier, and RestaurantId values that make the execution queryable by business dimensions.',
		control: 'query-status',
		completes: (e) => e.type === 'QueryCompleted'
	},
	{
		id: 'search-attributes',
		title: 'Filter with Temporal Visibility',
		instruction:
			'Click "List Visibility" to filter executions by the real Search Attributes upserted by the workflow.',
		control: 'list-visibility',
		completes: (e) => e.type === 'QueryCompleted'
	},
	{
		id: 'durable-recovery',
		title: 'Kill the worker — watch it recover',
		instruction:
			'Click "Kill Worker" to terminate the Node.js process mid-flight. The Temporal server has preserved all workflow state. Restart the worker and watch the workflow resume exactly where it left off — this is the centrepiece of the Sandman demo.',
		control: 'kill-worker',
		// Completes ONLY on WorkerRestarted — WorkerKilled does not advance this step.
		completes: (e) => e.type === 'WorkerRestarted'
	},
	{
		id: 'complete-delivery',
		title: 'Complete the delivery workflow',
		instruction:
			'Click "Complete Delivery" to signal the delivery child workflow. The parent workflow observes the child completion and reaches the Delivered terminal state.',
		control: 'complete-delivery',
		completes: (e) => e.type === WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
	}
];
