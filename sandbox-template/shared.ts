/**
 * shared.ts — type constants and helpers for the Sandman food-ordering
 * sandbox template.
 *
 * This file is a STANDALONE mirror of src/lib/contracts/workflow-api.ts.
 * It ships inside the E2B Firecracker MicroVM where src/lib/ is absent,
 * so it MUST NOT import from the app layer. If you update workflow-api.ts,
 * keep this file in sync.
 */

// ---------------------------------------------------------------------------
// Monetary primitive
// ---------------------------------------------------------------------------

/** An amount of money expressed as integer cents (e.g. 1099 = $10.99). */
export type MoneyCents = number;

// ---------------------------------------------------------------------------
// Customer tier
// ---------------------------------------------------------------------------

/** Customer tier — affects priority routing and discount eligibility. */
export const CUSTOMER_TIER = {
	Standard: 'standard',
	Premium: 'premium',
	Enterprise: 'enterprise'
} as const;

export type CustomerTier = (typeof CUSTOMER_TIER)[keyof typeof CUSTOMER_TIER];

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

/** All possible order lifecycle states. */
export const ORDER_STATUS = {
	Created: 'CREATED',
	Validating: 'VALIDATING',
	AwaitingRestaurant: 'AWAITING_RESTAURANT',
	Preparing: 'PREPARING',
	AwaitingCourier: 'AWAITING_COURIER',
	InDelivery: 'IN_DELIVERY',
	Delivered: 'DELIVERED',
	Cancelled: 'CANCELLED',
	Refunded: 'REFUNDED'
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

// ---------------------------------------------------------------------------
// Task-queue and workflow-type constants
// ---------------------------------------------------------------------------

/** Temporal task queue shared by the Sandman worker and client. */
export const TASK_QUEUE = 'sandman-food' as const;

/** Workflow type name for the primary food-ordering orchestration workflow. */
// MUST equal the exported workflow function name below — the Temporal worker
// registers workflows by their function name (orderFoodWorkflow), so clients that
// start a different string fail with "workflow type not registered".
export const ORDER_FOOD_WORKFLOW = 'orderFoodWorkflow' as const;

/** Workflow type name for the delivery child workflow. */
export const DELIVERY_WORKFLOW = 'DeliveryWorkflow' as const;

/** Workflow type name for the subscription renewal workflow. */
export const SUBSCRIPTION_WORKFLOW = 'SubscriptionWorkflow' as const;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single item in an order. */
export type OrderItem = {
	itemId: string;
	name: string;
	quantity: number;
	unitPriceCents: MoneyCents;
};

/** Delivery address for the order. */
export type DeliveryAddress = {
	street: string;
	city: string;
	state: string;
	postalCode: string;
	notes?: string;
};

/** Payment method — discriminated union on `type`. */
export type PaymentMethod =
	| { type: 'card'; last4: string; brand: string }
	| { type: 'wallet'; provider: 'apple-pay' | 'google-pay' }
	| { type: 'credits'; balanceCents: MoneyCents };

/** Input passed to `orderFoodWorkflow` when placing a new food order. */
export type OrderInput = {
	orderId: string;
	items: OrderItem[];
	deliveryAddress: DeliveryAddress;
	customerTier: CustomerTier;
	paymentMethod: PaymentMethod;
	restaurantId: string;
	customerId: string;
	promoCode?: string;
	restaurantAcceptTimeoutMinutes?: number;
	historyCompactionThreshold?: number;
	visibilitySearchAttributesEnabled?: boolean;
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalName =
	| 'cancelOrder'
	| 'restaurantAccepted'
	| 'restaurantRejected'
	| 'foodReady'
	| 'courierLocationUpdate'
	| 'addTip'
	| 'deliveryCompleted';

export type CancelOrderSignal = { reason: string };
export type RestaurantAcceptedSignal = { estimatedPrepMinutes: number };
export type RestaurantRejectedSignal = { reason: string; retryable: boolean };
export type FoodReadySignal = Record<string, never>;
export type CourierLocationUpdate = { lat: number; lng: number; speedKmh?: number };
export type AddTipSignal = { amountCents: MoneyCents };
export type DeliveryCompletedSignal = Record<string, never>;

export type SignalPayloadMap = {
	cancelOrder: CancelOrderSignal;
	restaurantAccepted: RestaurantAcceptedSignal;
	restaurantRejected: RestaurantRejectedSignal;
	foodReady: FoodReadySignal;
	courierLocationUpdate: CourierLocationUpdate;
	addTip: AddTipSignal;
	deliveryCompleted: DeliveryCompletedSignal;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type QueryName = 'getStatus' | 'getTimeline';

export type CourierInfo = {
	courierId: string;
	name: string;
	location?: CourierLocationUpdate;
	etaMinutes?: number;
};

export type CompensationRecord = {
	action: string;
	timestamp: string;
	ok: boolean;
	errorMessage?: string;
};

export type BusinessSnapshot = {
	OrderStatus: OrderStatus;
	CustomerTier: CustomerTier;
	RestaurantId: string;
};

export type SearchAttributeMetadata = {
	key: keyof BusinessSnapshot;
	type: 'Keyword';
	description: string;
};

export type VisibilityFilter = {
	status?: OrderStatus;
	customerTier?: CustomerTier;
	restaurantId?: string;
};

export type VisibilityWorkflowSummary = {
	workflowId: string;
	runId: string;
	status: string;
	type?: string;
	businessSnapshot: Partial<BusinessSnapshot>;
};

export type ActivityOperationMetadata = {
	operationId: string;
	idempotencyKey: string;
	workflowId: string;
	orderId: string;
};

/** Full queryable state of a live order workflow. */
export type OrderSnapshot = {
	status: OrderStatus;
	input: OrderInput;
	subtotalCents: MoneyCents;
	deliveryFeeCents: MoneyCents;
	tipCents: MoneyCents;
	promoDiscountCents: MoneyCents;
	totalCents: MoneyCents;
	attemptCounts: Record<string, number>;
	compensations: CompensationRecord[];
	activityOperations: Record<string, ActivityOperationMetadata>;
	courier?: CourierInfo;
	locationUpdateCount: number;
	restaurantDeadline?: string;
	deliveryDeadline?: string;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	appliedPromoCode?: string;
	continueAsNewPending: boolean;
	businessSnapshot: BusinessSnapshot;
	timelineDescriptions: string[];
};

export const SEARCH_ATTRIBUTE_METADATA = [
	{
		key: 'OrderStatus',
		type: 'Keyword',
		description: 'Current business lifecycle state for the order workflow.'
	},
	{
		key: 'CustomerTier',
		type: 'Keyword',
		description: 'Customer tier used for workshop filtering and prioritization examples.'
	},
	{
		key: 'RestaurantId',
		type: 'Keyword',
		description: 'Restaurant identifier used to find all orders for one merchant.'
	}
] as const satisfies readonly SearchAttributeMetadata[];

export const SIGNAL_NAMES = [
	'cancelOrder',
	'restaurantAccepted',
	'restaurantRejected',
	'foodReady',
	'courierLocationUpdate',
	'addTip',
	'deliveryCompleted'
] as const satisfies readonly SignalName[];

export const QUERY_NAMES = ['getStatus', 'getTimeline'] as const satisfies readonly QueryName[];

export const UPDATE_NAMES = [
	'updateDeliveryAddress',
	'applyPromoCode'
] as const satisfies readonly UpdateName[];

export const WORKFLOW_EVENT_TYPE = {
	WorkflowExecutionStarted: 'WorkflowExecutionStarted',
	WorkflowExecutionCompleted: 'WorkflowExecutionCompleted',
	WorkflowExecutionFailed: 'WorkflowExecutionFailed',
	WorkflowExecutionCanceled: 'WorkflowExecutionCanceled',
	WorkflowExecutionTerminated: 'WorkflowExecutionTerminated',
	WorkflowExecutionContinuedAsNew: 'WorkflowExecutionContinuedAsNew',
	ActivityTaskScheduled: 'ActivityTaskScheduled',
	ActivityTaskStarted: 'ActivityTaskStarted',
	ActivityTaskCompleted: 'ActivityTaskCompleted',
	ActivityTaskFailed: 'ActivityTaskFailed',
	ActivityTaskTimedOut: 'ActivityTaskTimedOut',
	ActivityTaskCancelRequested: 'ActivityTaskCancelRequested',
	ActivityTaskCanceled: 'ActivityTaskCanceled',
	TimerStarted: 'TimerStarted',
	TimerFired: 'TimerFired',
	TimerCanceled: 'TimerCanceled',
	WorkflowExecutionSignaled: 'WorkflowExecutionSignaled',
	WorkflowExecutionUpdateAccepted: 'WorkflowExecutionUpdateAccepted',
	WorkflowExecutionUpdateCompleted: 'WorkflowExecutionUpdateCompleted',
	WorkflowExecutionUpdateRejected: 'WorkflowExecutionUpdateRejected',
	ChildWorkflowExecutionStarted: 'ChildWorkflowExecutionStarted',
	ChildWorkflowExecutionCompleted: 'ChildWorkflowExecutionCompleted',
	ChildWorkflowExecutionFailed: 'ChildWorkflowExecutionFailed',
	StartChildWorkflowExecutionInitiated: 'StartChildWorkflowExecutionInitiated',
	MarkerRecorded: 'MarkerRecorded'
} as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPE)[keyof typeof WORKFLOW_EVENT_TYPE];

/** A single annotated entry in the order event timeline. */
export type TimelineEntry = {
	index: number;
	timestamp: string;
	description: string;
	status: OrderStatus;
	/** Optional feature identifier for guided-tour highlighting. */
	featureId?: FeatureId;
	/** Optional Temporal or UI event type that advances the guided tour. */
	eventType?: WorkflowEventType | 'QueryCompleted' | 'WorkerRestarted';
};

export type QueryReturnMap = {
	getStatus: OrderSnapshot;
	getTimeline: TimelineEntry[];
};

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export type UpdateName = 'updateDeliveryAddress' | 'applyPromoCode';

export type UpdateDeliveryAddressInput = { newAddress: DeliveryAddress };
export type UpdateDeliveryAddressResult = { updated: boolean; effectiveAddress: DeliveryAddress };
export type UpdateDeliveryAddressRejection =
	| 'order-already-in-delivery'
	| 'order-already-completed'
	| 'order-cancelled';

export type ApplyPromoCodeInput = { code: string };
export type ApplyPromoCodeResult = {
	discountCents: MoneyCents;
	newTotalCents: MoneyCents;
	description: string;
};
export type ApplyPromoCodeRejection =
	| 'invalid-code'
	| 'code-already-used'
	| 'code-expired'
	| 'order-already-completed'
	| 'order-cancelled';

// ---------------------------------------------------------------------------
// Delivery workflow types
// ---------------------------------------------------------------------------

/** Input for the delivery child workflow. */
export type DeliveryInput = {
	orderId: string;
	courierId: string;
	courierName: string;
	deliveryAddress: DeliveryAddress;
	/** Heartbeat interval in ms — set low in tests for fast iteration. */
	heartbeatIntervalMs?: number;
	/** SLA timeout duration for delivery completion. Defaults to '2h'. */
	slaTimeout?: string;
	/**
	 * Maximum heartbeat ticks before `trackCourier` exits naturally.
	 * Undefined (default) loops forever. Set in tests to let the SLA timer
	 * fire via time-skip once the activity has completed.
	 */
	maxTrackerTicks?: number;
};

/** Result returned by `deliveryWorkflow`. */
export type DeliveryResult = {
	deliveredOnTime: boolean;
	courierId: string;
};

// ---------------------------------------------------------------------------
// Subscription workflow types
// ---------------------------------------------------------------------------

/** Input for the subscription workflow. Carries state across continueAsNew. */
export type SubscriptionInput = {
	customerId: string;
	baseOrder: Omit<OrderInput, 'orderId'>;
	cycleCount: number;
	lastOrderId?: string;
	/** Maximum number of cycles before the subscription ends (0 = unlimited). */
	maxCycles?: number;
};

// ---------------------------------------------------------------------------
// Feature IDs — mirrors src/lib/contracts/workflow-api.ts FeatureId
// ---------------------------------------------------------------------------

/**
 * Stable identifiers for each Temporal feature demonstrated by the
 * Sandman food-ordering workflow.  This const mirrors the `FeatureId`
 * union in `src/lib/contracts/workflow-api.ts` — keep the two in sync.
 * Having a runtime constant enables parity assertions in workflow tests
 * (the VM has no access to the app layer).
 */
export const FEATURE_ID = {
	ActivitiesRetry: 'activities-retry',
	NonRetryableFailure: 'non-retryable-failure',
	SagaCompensation: 'saga-compensation',
	Signals: 'signals',
	Queries: 'queries',
	UpdatesValidators: 'updates-validators',
	TimersDurableSleep: 'timers-durable-sleep',
	ChildWorkflow: 'child-workflow',
	HeartbeatsCancellation: 'heartbeats-cancellation',
	ContinueAsNew: 'continue-as-new',
	QueryableBusinessSnapshot: 'queryable-business-snapshot',
	SearchAttributes: 'search-attributes',
	LocalActivities: 'local-activities',
	ReplaySafety: 'replay-safety',
	DurableRecovery: 'durable-recovery'
} as const;

/** Union of all feature-identifier strings. Structurally equal to `FeatureId` in workflow-api.ts. */
export type FeatureId = (typeof FEATURE_ID)[keyof typeof FEATURE_ID];

export const SCENARIO_ID = {
	HappyPath: 'happy-path',
	Retry: 'retry',
	TimeoutRefund: 'timeout-refund',
	UpdateRejection: 'update-rejection',
	ChildDelivery: 'child-delivery',
	WorkerRecovery: 'worker-recovery',
	ContinueAsNew: 'continue-as-new',
	ReplaySafety: 'replay-safety',
	SearchAttributes: 'search-attributes'
} as const;

export type ScenarioId = (typeof SCENARIO_ID)[keyof typeof SCENARIO_ID];

export type ScenarioStep = {
	id: string;
	control?: ControlId;
	featureId: FeatureId;
	completesOn: WorkflowEventType | 'QueryCompleted' | 'WorkerRestarted';
};

export type Scenario = {
	id: ScenarioId;
	title: string;
	summary: string;
	steps: readonly ScenarioStep[];
};

export type ControlId =
	| 'start-order'
	| 'cancel-order'
	| 'accept-restaurant'
	| 'reject-restaurant'
	| 'food-ready'
	| 'update-location'
	| 'add-tip'
	| 'update-address'
	| 'apply-promo'
	| 'complete-delivery'
	| 'kill-worker'
	| 'list-visibility'
	| 'query-status'
	| 'query-timeline';

export const SCENARIOS = [
	{
		id: SCENARIO_ID.HappyPath,
		title: 'Deliver one order',
		summary:
			'Start the workflow, accept the order, update it, start the delivery child workflow, and complete delivery.',
		steps: [
			{
				id: 'start-workflow',
				control: 'start-order',
				featureId: 'activities-retry',
				completesOn: 'WorkflowExecutionStarted'
			},
			{
				id: 'restaurant-accepts',
				control: 'accept-restaurant',
				featureId: 'signals',
				completesOn: 'WorkflowExecutionSignaled'
			},
			{
				id: 'address-update',
				control: 'update-address',
				featureId: 'updates-validators',
				completesOn: 'WorkflowExecutionUpdateAccepted'
			},
			{
				id: 'delivery-child',
				control: 'food-ready',
				featureId: 'child-workflow',
				completesOn: 'ChildWorkflowExecutionStarted'
			},
			{
				id: 'complete-delivery',
				control: 'complete-delivery',
				featureId: 'child-workflow',
				completesOn: 'WorkflowExecutionCompleted'
			}
		]
	},
	{
		id: SCENARIO_ID.Retry,
		title: 'Watch activity retry',
		summary:
			'Use the transient-failure payment fixture to show Temporal retrying an activity without workflow-side retry loops.',
		steps: [
			{
				id: 'activity-completes-after-retry',
				control: 'start-order',
				featureId: 'activities-retry',
				completesOn: 'ActivityTaskCompleted'
			}
		]
	},
	{
		id: SCENARIO_ID.TimeoutRefund,
		title: 'Let the restaurant timeout refund the order',
		summary:
			'Start an order and do not accept it; the durable timer fires and compensation refunds the payment.',
		steps: [
			{
				id: 'restaurant-deadline',
				control: 'start-order',
				featureId: 'timers-durable-sleep',
				completesOn: 'TimerStarted'
			}
		]
	},
	{
		id: SCENARIO_ID.UpdateRejection,
		title: 'Reject an invalid update',
		summary:
			'Try to change the address after delivery begins so the update validator rejects before the handler mutates state.',
		steps: [
			{
				id: 'validator-rejects',
				control: 'update-address',
				featureId: 'updates-validators',
				completesOn: 'WorkflowExecutionUpdateRejected'
			}
		]
	},
	{
		id: SCENARIO_ID.ChildDelivery,
		title: 'Inspect the delivery child workflow',
		summary:
			'Start delivery and inspect the child workflow as a separate execution in Temporal Web.',
		steps: [
			{
				id: 'child-started',
				control: 'food-ready',
				featureId: 'child-workflow',
				completesOn: 'ChildWorkflowExecutionStarted'
			}
		]
	},
	{
		id: SCENARIO_ID.WorkerRecovery,
		title: 'Kill and restart the worker',
		summary:
			'Stop the worker while the workflow is waiting, then restart it and watch history replay restore execution.',
		steps: [
			{
				id: 'worker-restarted',
				control: 'kill-worker',
				featureId: 'durable-recovery',
				completesOn: 'WorkerRestarted'
			}
		]
	},
	{
		id: SCENARIO_ID.ContinueAsNew,
		title: 'Compact a long history',
		summary:
			'Run with a low history-compaction threshold and send courier location updates until ContinueAsNew starts a fresh run.',
		steps: [
			{
				id: 'continued-as-new',
				control: 'update-location',
				featureId: 'continue-as-new',
				completesOn: 'WorkflowExecutionContinuedAsNew'
			}
		]
	},
	{
		id: SCENARIO_ID.ReplaySafety,
		title: 'Replay the recorded history',
		summary:
			'Use the workflow test replayer to prove the workflow code is deterministic against a real event history.',
		steps: [
			{
				id: 'query-timeline',
				control: 'query-timeline',
				featureId: 'replay-safety',
				completesOn: 'QueryCompleted'
			}
		]
	},
	{
		id: SCENARIO_ID.SearchAttributes,
		title: 'Filter with Temporal Visibility',
		summary:
			'List workflows by real Search Attributes after first reading the queryable business snapshot.',
		steps: [
			{
				id: 'list-visibility',
				control: 'list-visibility',
				featureId: 'search-attributes',
				completesOn: 'QueryCompleted'
			}
		]
	}
] as const satisfies readonly Scenario[];

// ---------------------------------------------------------------------------
// Known promo codes (deterministic — no I/O in workflow)
// ---------------------------------------------------------------------------

/** Promo codes known to the workflow. Defined here so tests can reference them. */
export const PROMO_CODES = {
	SAVE10: { discountPercent: 10, description: '10% off your order' },
	SAVE20: { discountPercent: 20, description: '20% off your order' },
	FLAT500: { discountCents: 500, description: '$5 off your order' }
} as const;

/** Type of a valid promo code key. */
export type PromoCodeKey = keyof typeof PROMO_CODES;

// ---------------------------------------------------------------------------
// Browser demo globals
// ---------------------------------------------------------------------------

/**
 * Keep the editable workflow files focused on Temporal behavior instead of long
 * type-import lists. These aliases are ambient only; runtime values still need
 * normal imports from this module.
 */
declare global {
	type MoneyCents = import('./shared.ts').MoneyCents;
	type CustomerTier = import('./shared.ts').CustomerTier;
	type OrderStatus = import('./shared.ts').OrderStatus;
	type OrderItem = import('./shared.ts').OrderItem;
	type DeliveryAddress = import('./shared.ts').DeliveryAddress;
	type PaymentMethod = import('./shared.ts').PaymentMethod;
	type OrderInput = import('./shared.ts').OrderInput;
	type SignalName = import('./shared.ts').SignalName;
	type CancelOrderSignal = import('./shared.ts').CancelOrderSignal;
	type RestaurantAcceptedSignal = import('./shared.ts').RestaurantAcceptedSignal;
	type RestaurantRejectedSignal = import('./shared.ts').RestaurantRejectedSignal;
	type FoodReadySignal = import('./shared.ts').FoodReadySignal;
	type CourierLocationUpdate = import('./shared.ts').CourierLocationUpdate;
	type AddTipSignal = import('./shared.ts').AddTipSignal;
	type DeliveryCompletedSignal = import('./shared.ts').DeliveryCompletedSignal;
	type SignalPayloadMap = import('./shared.ts').SignalPayloadMap;
	type QueryName = import('./shared.ts').QueryName;
	type CourierInfo = import('./shared.ts').CourierInfo;
	type CompensationRecord = import('./shared.ts').CompensationRecord;
	type BusinessSnapshot = import('./shared.ts').BusinessSnapshot;
	type SearchAttributeMetadata = import('./shared.ts').SearchAttributeMetadata;
	type VisibilityFilter = import('./shared.ts').VisibilityFilter;
	type VisibilityWorkflowSummary = import('./shared.ts').VisibilityWorkflowSummary;
	type ActivityOperationMetadata = import('./shared.ts').ActivityOperationMetadata;
	type OrderSnapshot = import('./shared.ts').OrderSnapshot;
	type TimelineEntry = import('./shared.ts').TimelineEntry;
	type WorkflowEventType = import('./shared.ts').WorkflowEventType;
	type QueryReturnMap = import('./shared.ts').QueryReturnMap;
	type UpdateName = import('./shared.ts').UpdateName;
	type UpdateDeliveryAddressInput = import('./shared.ts').UpdateDeliveryAddressInput;
	type UpdateDeliveryAddressResult = import('./shared.ts').UpdateDeliveryAddressResult;
	type UpdateDeliveryAddressRejection = import('./shared.ts').UpdateDeliveryAddressRejection;
	type ApplyPromoCodeInput = import('./shared.ts').ApplyPromoCodeInput;
	type ApplyPromoCodeResult = import('./shared.ts').ApplyPromoCodeResult;
	type ApplyPromoCodeRejection = import('./shared.ts').ApplyPromoCodeRejection;
	type DeliveryInput = import('./shared.ts').DeliveryInput;
	type DeliveryResult = import('./shared.ts').DeliveryResult;
	type SubscriptionInput = import('./shared.ts').SubscriptionInput;
	type FeatureId = import('./shared.ts').FeatureId;
	type PromoCodeKey = import('./shared.ts').PromoCodeKey;
	type ControlId = import('./shared.ts').ControlId;
	type ScenarioId = import('./shared.ts').ScenarioId;
	type ScenarioStep = import('./shared.ts').ScenarioStep;
	type Scenario = import('./shared.ts').Scenario;
}
