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
	OrderInput,
	OrderStatus,
	TimelineEntry,
	WorkflowEventType
} from '$lib/contracts/workflow-api';
import { ORDER_STATUS } from '$lib/contracts/workflow-api';
import type { ExecutionPointer } from '$lib/components/editor/execution-pointer';

/** The order lifecycle phase the UI is in — `idle` until a run starts. */
export type SessionPhase = 'idle' | OrderStatus;

/** Which surface the center of the workbench shows. */
export type CenterView = 'code' | 'temporal';

/** Order phases in which the workflow is still running (not terminal). */
const ACTIVE_PHASES: readonly SessionPhase[] = [
	ORDER_STATUS.Received,
	ORDER_STATUS.WaitingForRestaurant,
	ORDER_STATUS.Preparing
];

/**
 * Derive the current phase from the latest polled timeline entry.
 * Before the first timeline entry arrives, a started run reads as Received.
 */
export function derivePhase(hasRun: boolean, entries: readonly TimelineEntry[]): SessionPhase {
	if (!hasRun) return 'idle';
	return entries.at(-1)?.status ?? ORDER_STATUS.Received;
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
 *  - **Signals** (accept-restaurant, complete-delivery, cancel-order) are
 *    accepted by the *server* and appended to history even while the worker
 *    is down — they replay once it returns. They stay enabled without a
 *    worker; that durability is part of the lesson.
 *  - **Queries** (query-status) and **starting** a workflow (nothing
 *    advances it without a poller) are worker-served, so they gate on
 *    `workerOnline`.
 */
export function canUseControl(control: ControlId, context: ControlContext): boolean {
	const { phase, sandboxUsable, serverOnline, workerOnline } = context;
	if (!sandboxUsable || !serverOnline) return false;
	const running = isRunActive(phase);

	switch (control) {
		case 'start-order':
			return phase === 'idle' && workerOnline;
		case 'accept-restaurant':
			return phase === ORDER_STATUS.WaitingForRestaurant;
		case 'complete-delivery':
			return phase === ORDER_STATUS.Preparing;
		case 'query-status':
			return phase !== 'idle' && workerOnline;
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

/** Prefilled values used by every one-click order. */
export const DEMO_ORDER_DEFAULTS = {
	/** The default demo card: charges succeed on the first attempt. */
	cardLast4: '4242',
	/** The flaky demo card: the first charge attempt fails, then Temporal retries. */
	flakyCardLast4: '0000',
	cancelReason: 'Customer cancelled from the sandbox control plane'
} as const;

/**
 * Build a demo order input. Pass an explicit `orderId` to reconstruct the
 * order behind an already-running workflow (the workflow id IS the order id —
 * the start route passes `--workflow-id ${orderId}`); omit it for a fresh one.
 */
export function buildDemoOrder(orderId: string = crypto.randomUUID()): OrderInput {
	return {
		orderId,
		items: [
			{ name: 'Spicy noodles', quantity: 1, priceCents: 1295 },
			{ name: 'Ginger lime soda', quantity: 1, priceCents: 425 }
		],
		cardLast4: DEMO_ORDER_DEFAULTS.cardLast4
	};
}

/**
 * Infer the Temporal history event behind a polled timeline entry from the
 * status transition it recorded.
 *
 * The workflow's timeline is deliberately plain (timestamp + description +
 * status) so the sandbox code stays focused on teaching Temporal, not on
 * feeding this UI. Each status transition still maps 1:1 onto a real history
 * event, so the guided tour and event rail derive their events here instead —
 * robust to learners editing the description strings in workflow.ts.
 */
export function inferWorkflowEventType(
	previousStatus: OrderStatus | undefined,
	entry: TimelineEntry
): WorkflowEventType | undefined {
	const status = entry.status;
	if (previousStatus === undefined) {
		// The first entry accompanies the workflow start, which the UI already
		// emits synthetically when it starts the run.
		return undefined;
	}
	if (previousStatus === ORDER_STATUS.Received && status === ORDER_STATUS.Received) {
		// Second RECEIVED entry: the payment charge activity finished.
		return 'ActivityTaskCompleted';
	}
	if (status === ORDER_STATUS.WaitingForRestaurant) {
		// Entering the restaurant wait starts the durable deadline timer.
		return 'TimerStarted';
	}
	if (status === ORDER_STATUS.Preparing) {
		// Only the restaurantAccepted signal moves the order to Preparing.
		return 'WorkflowExecutionSignaled';
	}
	if (status === ORDER_STATUS.Delivered) {
		return 'WorkflowExecutionCompleted';
	}
	if (status === ORDER_STATUS.Refunded) {
		// The deadline timer fired and the workflow refunded the payment.
		return 'TimerFired';
	}
	if (status === ORDER_STATUS.Cancelled) {
		// Payment failure cancels from Received; otherwise the cancel signal did it.
		return previousStatus === ORDER_STATUS.Received
			? 'ActivityTaskFailed'
			: 'WorkflowExecutionSignaled';
	}
	return undefined;
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
 * `sandbox-template/workflow.ts` (the anti-drift test asserts this),
 * resolved to a line number against the live editor buffer so it survives
 * edits.
 */
const EXECUTION_ANCHORS: Partial<Record<OrderStatus, { anchor: string; label: string }>> = {
	[ORDER_STATUS.Received]: {
		anchor: 'await chargePayment(',
		label: 'charging the customer — an activity with automatic retries'
	},
	[ORDER_STATUS.WaitingForRestaurant]: {
		anchor: 'const accepted = await condition(',
		label: 'parked on condition() — waiting for the restaurant, guarded by a durable timer'
	},
	[ORDER_STATUS.Preparing]: {
		anchor: 'await condition(() => delivered',
		label: 'waiting for the deliveryCompleted signal'
	},
	[ORDER_STATUS.Delivered]: {
		anchor: "step(ORDER_STATUS.Delivered, 'Order delivered');",
		label: 'terminal state — the workflow returned its final snapshot'
	},
	[ORDER_STATUS.Cancelled]: {
		anchor: 'await refundPayment(',
		label: 'the charge was refunded before the order finished as cancelled'
	},
	[ORDER_STATUS.Refunded]: {
		anchor: 'await refundPayment(',
		label: 'the durable timer fired and the payment was refunded automatically'
	}
};

/**
 * The execution pointer for the current phase, or null while idle.
 * Worker liveness turns the pointer amber: paused while the process is dead,
 * replaying while a restarted worker rebuilds state from history.
 */
export function executionPointerFor(
	phase: SessionPhase,
	workerOnline: boolean,
	workerRestarting: boolean
): ExecutionPointer | null {
	if (phase === 'idle') return null;
	const entry = EXECUTION_ANCHORS[phase];
	if (entry === undefined) return null;
	return {
		file: 'workflow.ts',
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
		case ORDER_STATUS.Received:
			return 'charging card';
		case ORDER_STATUS.WaitingForRestaurant:
			return 'awaiting restaurant';
		case ORDER_STATUS.Preparing:
			return 'preparing';
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
