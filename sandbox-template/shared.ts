/**
 * shared.ts — the types and constants shared by the workflow, worker, and client.
 *
 * This file is a STANDALONE mirror of `src/lib/contracts/workflow-api.ts`.
 * It ships inside the E2B MicroVM where `src/lib/` is absent, so it must not
 * import from the app layer. If you change `workflow-api.ts`, keep this file
 * in sync.
 *
 * There is nothing Temporal-specific in here — just the plain data shapes the
 * order moves through. Start reading in `workflow.ts`; come back here whenever
 * you want to see what a type actually contains.
 */

/** An amount of money expressed as integer cents (e.g. 1099 = $10.99). */
export type MoneyCents = number;

/**
 * The task queue connects the two halves of Temporal: clients enqueue work on
 * a named queue, and workers poll that same name for things to run. The
 * worker (worker.ts) and every client must agree on this string.
 */
export const TASK_QUEUE = 'orders' as const;

/**
 * The workflow type name. Temporal registers workflows by their exported
 * function name, so this MUST equal the name of the function in workflow.ts —
 * starting a workflow with any other string fails with "workflow type not
 * registered".
 */
export const ORDER_WORKFLOW = 'orderWorkflow' as const;

/** Every state an order can be in, in the happy-path order they occur. */
export const ORDER_STATUS = {
	/** The workflow has started and is charging the card. */
	Received: 'RECEIVED',
	/** Payment succeeded; a durable timer is running while we wait for the restaurant. */
	WaitingForRestaurant: 'WAITING_FOR_RESTAURANT',
	/** The restaurant accepted and is cooking; we are waiting for delivery. */
	Preparing: 'PREPARING',
	/** Terminal: the order arrived. */
	Delivered: 'DELIVERED',
	/** Terminal: the restaurant never accepted, so the payment was refunded. */
	Refunded: 'REFUNDED',
	/** Terminal: the customer cancelled (or payment failed). */
	Cancelled: 'CANCELLED'
} as const;

/** Union of all order status strings. */
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** One line item in an order. */
export type OrderItem = {
	name: string;
	quantity: number;
	priceCents: MoneyCents;
};

/**
 * The input you pass when starting the workflow.
 *
 * `cardLast4` drives the payment demo in activities.ts:
 *   - '0000' — the first charge attempt fails, so you can watch Temporal retry
 *   - '9999' — the card is declined (a non-retryable failure)
 *   - anything else — the charge succeeds on the first try
 */
export type OrderInput = {
	orderId: string;
	items: OrderItem[];
	cardLast4: string;
	/** How long the durable timer waits for the restaurant before refunding. Default: 300. */
	restaurantTimeoutSeconds?: number;
};

/** One human-readable entry in the order's story, recorded as the workflow runs. */
export type TimelineEntry = {
	/** ISO-8601 timestamp of when this happened. */
	timestamp: string;
	/** What happened, in plain English. */
	description: string;
	/** The order status after this step. */
	status: OrderStatus;
};

/**
 * Everything the `getStatus` query returns — the workflow's live, in-memory
 * state. The control plane polls this to render the order.
 */
export type OrderSnapshot = {
	status: OrderStatus;
	orderId: string;
	items: OrderItem[];
	totalCents: MoneyCents;
	/** How many attempts the payment charge took (2+ means Temporal retried it). */
	paymentAttempts: number;
	/** Why the order was cancelled, when the customer cancelled it. */
	cancelReason?: string;
	/** ISO-8601 timestamp of when the workflow started. */
	startedAt: string;
	/** The order's story so far, oldest first. */
	timeline: TimelineEntry[];
};

// ---------------------------------------------------------------------------
// Signal and query names — the workflow's public API
// ---------------------------------------------------------------------------

/** Signals: async messages INTO the running workflow. */
export type SignalName = 'restaurantAccepted' | 'deliveryCompleted' | 'cancelOrder';

/** Payload for the `cancelOrder` signal. */
export type CancelOrderSignal = { reason: string };

/** Maps each signal name to its payload type. */
export type SignalPayloadMap = {
	restaurantAccepted: Record<string, never>;
	deliveryCompleted: Record<string, never>;
	cancelOrder: CancelOrderSignal;
};

/** Queries: read-only questions asked OF the running workflow. */
export type QueryName = 'getStatus';

/** Maps each query name to its return type. */
export type QueryReturnMap = {
	getStatus: OrderSnapshot;
};

export const SIGNAL_NAMES = [
	'restaurantAccepted',
	'deliveryCompleted',
	'cancelOrder'
] as const satisfies readonly SignalName[];

export const QUERY_NAMES = ['getStatus'] as const satisfies readonly QueryName[];
