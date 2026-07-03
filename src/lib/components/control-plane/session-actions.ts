/**
 * session-actions.ts — pure logic behind the session workbench.
 *
 * Everything here is framework-free and unit-testable: deriving the current
 * order phase from the polled timeline, gating which controls are usable in
 * that phase, the canned demo payloads the one-click toolbar sends, and the
 * status-chip mappings for the header and topology strip.
 */
import type {
	ControlId,
	DeliveryAddress,
	OrderInput,
	OrderStatus,
	TimelineEntry
} from '$lib/contracts/workflow-api';
import { CUSTOMER_TIER, ORDER_STATUS } from '$lib/contracts/workflow-api';
import type { ExecutionPointer } from '$lib/components/editor/execution-pointer';

/** The order lifecycle phase the UI is in — `idle` until a run starts. */
export type SessionPhase = 'idle' | OrderStatus;

/** Which surface the center of the workbench shows. */
export type CenterView = 'code' | 'temporal';

/** Order phases in which the workflow is still running (not terminal). */
const ACTIVE_PHASES: readonly SessionPhase[] = [
	ORDER_STATUS.Created,
	ORDER_STATUS.Validating,
	ORDER_STATUS.AwaitingRestaurant,
	ORDER_STATUS.Preparing,
	ORDER_STATUS.AwaitingCourier,
	ORDER_STATUS.InDelivery
];

/**
 * Derive the current phase from the latest polled timeline entry.
 * Before the first timeline entry arrives, a started run reads as Created.
 */
export function derivePhase(hasRun: boolean, entries: readonly TimelineEntry[]): SessionPhase {
	if (!hasRun) return 'idle';
	return entries.at(-1)?.status ?? ORDER_STATUS.Created;
}

/** Whether the workflow is started and not yet in a terminal state. */
export function isRunActive(phase: SessionPhase): boolean {
	return ACTIVE_PHASES.includes(phase);
}

/** Context the control-gating logic needs. */
export type ControlContext = {
	phase: SessionPhase;
	sandboxUsable: boolean;
	serverOnline: boolean;
	workerOnline: boolean;
};

/**
 * Whether a control-plane action can run right now.
 *
 * Every workflow operation needs the Temporal server up. Beyond that, the
 * split is by who actually serves the call:
 *
 *  - **Signals** (accept/reject restaurant, food-ready, add-tip, cancel,
 *    update-location) are accepted by the *server* and appended to history
 *    even while the worker is down — they replay once it returns. They stay
 *    enabled without a worker; that durability is part of the lesson.
 *  - **`list-visibility`** hits the server-side Visibility API (Search
 *    Attributes), so it also does not need the worker.
 *  - **Queries** (get-status, get-timeline), **updates** (update-address,
 *    apply-promo — their validators and handlers run on the worker),
 *    **starting** a workflow (nothing advances it without a poller), and
 *    **observing the delivery child** (complete-delivery) are all
 *    worker-served, so they gate on `workerOnline`.
 */
export function canUseControl(control: ControlId, context: ControlContext): boolean {
	const { phase, sandboxUsable, serverOnline, workerOnline } = context;
	if (!sandboxUsable || !serverOnline) return false;
	const running = isRunActive(phase);

	switch (control) {
		case 'start-order':
			return phase === 'idle' && workerOnline;
		case 'accept-restaurant':
		case 'reject-restaurant':
			return phase === ORDER_STATUS.AwaitingRestaurant;
		case 'food-ready':
			return phase === ORDER_STATUS.Preparing;
		case 'update-address':
		case 'apply-promo':
			return (
				workerOnline &&
				(phase === ORDER_STATUS.AwaitingRestaurant ||
					phase === ORDER_STATUS.Preparing ||
					phase === ORDER_STATUS.AwaitingCourier ||
					phase === ORDER_STATUS.InDelivery)
			);
		case 'add-tip':
			return (
				phase === ORDER_STATUS.Preparing ||
				phase === ORDER_STATUS.AwaitingCourier ||
				phase === ORDER_STATUS.InDelivery
			);
		case 'update-location':
			return phase === ORDER_STATUS.InDelivery;
		case 'complete-delivery':
			return phase === ORDER_STATUS.InDelivery && workerOnline;
		case 'query-status':
		case 'query-timeline':
			return phase !== 'idle' && workerOnline;
		case 'list-visibility':
			return phase !== 'idle';
		case 'kill-worker':
			return running && workerOnline;
		case 'cancel-order':
			return running;
	}
	const exhaustive: never = control;
	return exhaustive;
}

// ---------------------------------------------------------------------------
// Canned demo payloads — the toolbar is one-click, so inputs are prefilled.
// ---------------------------------------------------------------------------

/** The demo restaurant and customer used for every one-click order. */
export const DEMO_ORDER_DEFAULTS = {
	restaurantId: 'kitchen-44',
	customerId: 'customer-2187',
	estimatedPrepMinutes: 20,
	tipCents: 500,
	cancelReason: 'Customer cancelled from the sandbox control plane',
	rejectReason: 'Kitchen is over capacity',
	promoCode: 'SAVE10'
} as const;

/** Address the update-address control switches the order to. */
export const DEMO_UPDATED_ADDRESS: DeliveryAddress = {
	street: '44 Maple Avenue',
	city: 'Denver',
	state: 'CO',
	postalCode: '80209',
	notes: 'Ring the doorbell twice'
};

/** Courier location the update-location control signals mid-delivery. */
export const DEMO_COURIER_LOCATION = {
	lat: 39.7392,
	lng: -104.9903,
	speedKmh: 24
} as const;

/** Build a fresh demo order input (new orderId each call). */
export function buildDemoOrder(): OrderInput {
	return {
		orderId: crypto.randomUUID(),
		restaurantId: DEMO_ORDER_DEFAULTS.restaurantId,
		customerId: DEMO_ORDER_DEFAULTS.customerId,
		customerTier: CUSTOMER_TIER.Standard,
		items: [
			{ itemId: 'spicy-noodles', name: 'Spicy noodles', quantity: 1, unitPriceCents: 1295 },
			{ itemId: 'ginger-lime-soda', name: 'Ginger lime soda', quantity: 1, unitPriceCents: 425 }
		],
		deliveryAddress: {
			street: '221 Market Street',
			city: 'Denver',
			state: 'CO',
			postalCode: '80205',
			notes: 'Leave at the front desk'
		},
		paymentMethod: { type: 'card', last4: '4242', brand: 'Visa' },
		visibilitySearchAttributesEnabled: true
	};
}

/** The child DeliveryWorkflow id derived from the parent order id. */
export function deliveryWorkflowIdFor(orderId: string): string {
	return `delivery-${orderId}`;
}

/** Format integer cents as US dollars for toasts and summaries. */
export function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** The current time as an ISO-8601 string (for synthetic event timestamps). */
export function nowIso(): string {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Execution pointer — which line of workflow code each phase is executing
// ---------------------------------------------------------------------------

/**
 * Code anchor per order phase. Each anchor is a verbatim substring of
 * `sandbox-template/order-workflow.ts` (the anti-drift test asserts this),
 * resolved to a line number against the live editor buffer so it survives
 * edits.
 */
const EXECUTION_ANCHORS: Partial<Record<OrderStatus, { anchor: string; label: string }>> = {
	[ORDER_STATUS.Created]: {
		anchor: 'await validateOrder(currentInput);',
		label: 'validating the order — a local activity'
	},
	[ORDER_STATUS.Validating]: {
		anchor: 'await chargePayment(',
		label: 'charging the customer — an activity with automatic retries'
	},
	[ORDER_STATUS.AwaitingRestaurant]: {
		anchor: 'const accepted = await condition(',
		label: 'parked on condition() — waiting for the restaurant, guarded by a durable timer'
	},
	[ORDER_STATUS.Preparing]: {
		anchor: 'await condition(() => foodReady',
		label: 'waiting for the foodReady signal'
	},
	[ORDER_STATUS.AwaitingCourier]: {
		anchor: 'await assignCourier(',
		label: 'assigning and dispatching the courier — activities'
	},
	[ORDER_STATUS.InDelivery]: {
		// Anchor on `await child.result()`, where the parent is actually parked
		// for most of the phase — not the `startChild` call that returns at once.
		anchor: 'await child.result();',
		label: 'delivery running in a child workflow — the parent awaits its result'
	},
	[ORDER_STATUS.Delivered]: {
		anchor: "'Order delivered',",
		label: 'terminal state — the workflow returned its final snapshot'
	},
	[ORDER_STATUS.Cancelled]: {
		anchor: 'compensationStack.length - 1',
		label: 'saga compensation ran in reverse and refunded the payment'
	},
	[ORDER_STATUS.Refunded]: {
		anchor: 'compensationStack.length - 1',
		label: 'saga compensation ran in reverse and refunded the payment'
	}
};

const VALIDATING_PAYMENT_DESCRIPTIONS = new Set(['Charging payment', 'Payment charged']);

function executionAnchorFor(
	phase: OrderStatus,
	timelineEntries: TimelineEntry[] = []
): { anchor: string; label: string } | undefined {
	if (phase === ORDER_STATUS.Validating) {
		if (timelineEntries.some((entry) => VALIDATING_PAYMENT_DESCRIPTIONS.has(entry.description))) {
			return EXECUTION_ANCHORS[ORDER_STATUS.Validating];
		}
		return EXECUTION_ANCHORS[ORDER_STATUS.Created];
	}
	return EXECUTION_ANCHORS[phase];
}

/**
 * The execution pointer for the current phase, or null while idle.
 * Worker liveness turns the pointer amber: paused while the process is dead,
 * replaying while a restarted worker rebuilds state from history.
 */
export function executionPointerFor(
	phase: SessionPhase,
	workerOnline: boolean,
	workerRestarting: boolean,
	timelineEntries: TimelineEntry[] = []
): ExecutionPointer | null {
	if (phase === 'idle') return null;
	const entry = executionAnchorFor(phase, timelineEntries);
	if (entry === undefined) return null;
	return {
		file: 'order-workflow.ts',
		anchor: entry.anchor,
		label: entry.label,
		state: workerRestarting ? 'replaying' : workerOnline ? 'running' : 'paused'
	};
}

// ---------------------------------------------------------------------------
// Status-chip mappings
// ---------------------------------------------------------------------------

/** Cinder StatusDot statuses used by the chips (subset of the full union). */
export type ChipDot =
	| 'online'
	| 'offline'
	| 'warning'
	| 'danger'
	| 'pending'
	| 'neutral'
	| 'success'
	| 'accent';

/** Human stage label for the Order chip. */
export function orderStageLabel(phase: SessionPhase): string {
	switch (phase) {
		case 'idle':
			return 'not started';
		case ORDER_STATUS.Created:
			return 'placed';
		case ORDER_STATUS.Validating:
			return 'charging';
		case ORDER_STATUS.AwaitingRestaurant:
			return 'awaiting restaurant';
		case ORDER_STATUS.Preparing:
			return 'preparing';
		case ORDER_STATUS.AwaitingCourier:
			return 'awaiting courier';
		case ORDER_STATUS.InDelivery:
			return 'out for delivery';
		case ORDER_STATUS.Delivered:
			return 'delivered';
		case ORDER_STATUS.Cancelled:
			return 'cancelled';
		case ORDER_STATUS.Refunded:
			return 'refunded';
	}
	const exhaustive: never = phase;
	return exhaustive;
}

/** Dot color for the Order chip. */
export function orderStageDot(phase: SessionPhase): ChipDot {
	if (phase === 'idle') return 'neutral';
	if (phase === ORDER_STATUS.Delivered) return 'success';
	if (phase === ORDER_STATUS.Cancelled || phase === ORDER_STATUS.Refunded) return 'neutral';
	return 'accent';
}

/** Short tag for the Workflow chip. */
export function workflowTag(phase: SessionPhase): string {
	if (phase === 'idle') return 'idle';
	if (phase === ORDER_STATUS.Delivered) return 'completed';
	if (phase === ORDER_STATUS.Cancelled || phase === ORDER_STATUS.Refunded) return 'completed';
	return 'running';
}

/** Dot color for the Workflow chip. */
export function workflowDot(phase: SessionPhase): ChipDot {
	if (phase === 'idle') return 'neutral';
	if (phase === ORDER_STATUS.Delivered) return 'success';
	if (phase === ORDER_STATUS.Cancelled || phase === ORDER_STATUS.Refunded) return 'neutral';
	return 'accent';
}

/** Dot color for the Sandbox chip, keyed by the polled sandbox status. */
export function sandboxDot(status: string): ChipDot {
	switch (status) {
		case 'ready':
			return 'online';
		case 'provisioning':
		case 'bootstrapping':
			return 'pending';
		case 'authentication-required':
			return 'warning';
		case 'error':
		case 'expired':
		case 'terminated':
			return 'danger';
		default:
			return 'neutral';
	}
}
