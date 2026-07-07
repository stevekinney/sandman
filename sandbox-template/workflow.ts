/**
 * workflow.ts — the entire order workflow. Start reading here.
 *
 * A Temporal workflow is just a function — but every await in it is durable.
 * Temporal records each step (activity result, timer, signal) in an event
 * history; if the worker running this code dies, a new worker *replays* that
 * history and the function resumes exactly where it left off, local variables
 * and all. That one idea explains everything in this file.
 *
 * The order takes four steps:
 *
 *   1. Charge the card        — an activity, retried automatically on failure
 *   2. Wait for the restaurant — a signal, guarded by a durable timer
 *   3. Wait for delivery       — another signal
 *   4. Done                    — return the final state
 *
 * Look for "Try:" comments — each marks a small edit you can make (saving
 * hot-restarts the worker) to see visibly different behavior.
 */

import {
	condition,
	defineQuery,
	defineSignal,
	proxyActivities,
	setHandler
} from '@temporalio/workflow';
import type * as activities from './activities.ts';
import type {
	CancelOrderSignal,
	OrderInput,
	OrderSnapshot,
	OrderStatus,
	TimelineEntry
} from './shared.ts';
import { ORDER_STATUS } from './shared.ts';

// ---------------------------------------------------------------------------
// The workflow's public API: signals in, queries out
// ---------------------------------------------------------------------------

/** Signals are async messages INTO a running workflow. Anyone with the workflow ID can send one. */
export const restaurantAcceptedSignal = defineSignal('restaurantAccepted');
export const deliveryCompletedSignal = defineSignal('deliveryCompleted');
export const cancelOrderSignal = defineSignal<[CancelOrderSignal]>('cancelOrder');

/** Queries are read-only questions. Answering one never advances the workflow or writes history. */
export const getStatusQuery = defineQuery<OrderSnapshot>('getStatus');

// ---------------------------------------------------------------------------
// Activities — with the retry policy that makes them reliable
// ---------------------------------------------------------------------------

/**
 * This is a *proxy*: calling `chargePayment(...)` below doesn't run the
 * function here — it asks the Temporal server to schedule it, a worker runs
 * the real implementation in activities.ts, and the result is recorded in
 * history. If it throws, Temporal retries it using this policy. The workflow
 * never contains a retry loop.
 *
 * Try: set `maximumAttempts: 1` and start an order with card '0000' — the
 * first transient failure now fails the payment instead of retrying.
 */
const { chargePayment, notifyRestaurant, refundPayment } = proxyActivities<typeof activities>({
	// How long one attempt may run before Temporal times it out and retries.
	startToCloseTimeout: '30 seconds',
	retry: {
		initialInterval: '1 second',
		backoffCoefficient: 2,
		maximumAttempts: 5,
		// A declined card stays declined — retrying would never help.
		// activities.ts throws ApplicationFailure with this type to skip retries.
		nonRetryableErrorTypes: ['PaymentDeclined']
	}
});

/**
 * Workflow-safe "now": Temporal patches Date.now() to be deterministic on
 * replay, so every worker that replays this history sees the same timestamps.
 */
function now(): string {
	return new Date(Date.now()).toISOString();
}

// ---------------------------------------------------------------------------
// The workflow itself
// ---------------------------------------------------------------------------

export async function orderWorkflow(input: OrderInput): Promise<OrderSnapshot> {
	// Plain local variables — no database. Temporal's replay makes them
	// durable: after a crash, re-running the recorded history rebuilds every
	// one of these to exactly the value it had.
	let status: OrderStatus = ORDER_STATUS.Received;
	let paymentAttempts = 0;
	let cancelReason: string | undefined;
	let restaurantAccepted = false;
	let delivered = false;
	const timeline: TimelineEntry[] = [];
	const startedAt = now();

	// Prices are plain arithmetic — deterministic, so no activity needed.
	const totalCents = input.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);

	/** Move to a new status and record what happened on the order's timeline. */
	function step(nextStatus: OrderStatus, description: string): void {
		status = nextStatus;
		timeline.push({ timestamp: now(), description, status });
	}

	/** The full current state — this is what the getStatus query returns. */
	function snapshot(): OrderSnapshot {
		return {
			status,
			orderId: input.orderId,
			items: input.items,
			totalCents,
			paymentAttempts,
			cancelReason,
			startedAt,
			timeline
		};
	}

	// Signal handlers just flip local flags; the workflow body below waits on
	// them with condition(). Nothing polls.
	setHandler(restaurantAcceptedSignal, () => {
		restaurantAccepted = true;
	});
	setHandler(deliveryCompletedSignal, () => {
		delivered = true;
	});
	setHandler(cancelOrderSignal, ({ reason }) => {
		cancelReason = reason;
	});
	setHandler(getStatusQuery, snapshot);

	/** Undo the charge and finish the order in a terminal status. */
	async function refundAndFinish(
		terminalStatus: OrderStatus,
		description: string
	): Promise<OrderSnapshot> {
		await refundPayment(input.orderId, totalCents);
		step(terminalStatus, description);
		return snapshot();
	}

	// ── 1. Charge the card ────────────────────────────────────────────────
	step(ORDER_STATUS.Received, `Order received — ${input.items.length} item(s), charging card`);
	try {
		const charge = await chargePayment(input.orderId, input.cardLast4, totalCents);
		paymentAttempts = charge.attempts;
		step(
			ORDER_STATUS.Received,
			`Payment of $${(totalCents / 100).toFixed(2)} succeeded on attempt ${charge.attempts}`
		);
	} catch {
		// Only a payment that can never succeed lands here: a declined card
		// (non-retryable) or a charge that exhausted all five attempts.
		step(ORDER_STATUS.Cancelled, 'Payment failed — order cancelled');
		return snapshot();
	}

	// ── 2. Wait for the restaurant (signal + durable timer) ──────────────
	await notifyRestaurant(input.orderId, input.items);
	const timeoutSeconds = input.restaurantTimeoutSeconds ?? 300;
	step(
		ORDER_STATUS.WaitingForRestaurant,
		`Waiting up to ${timeoutSeconds}s for the restaurant to accept`
	);
	// The workflow parks HERE. condition() resumes when a signal handler
	// flips one of these flags — or when the timer fires (then it returns
	// false). The timer lives in the Temporal server: kill the worker and it
	// still counts down.
	// Try: start an order and never accept it — the timer fires and the
	// payment is refunded automatically. Shrink the timeout to make it quick.
	const accepted = await condition(
		() => restaurantAccepted || cancelReason !== undefined,
		`${timeoutSeconds} seconds`
	);
	if (!accepted) {
		return refundAndFinish(ORDER_STATUS.Refunded, 'Restaurant never accepted — payment refunded');
	}
	if (cancelReason !== undefined) {
		return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);
	}

	// ── 3. Wait for delivery (another signal, no timeout) ────────────────
	// This wait can last hours and survive any number of worker crashes.
	// Try: kill the worker now (the ⚡ button), restart it, and query status —
	// nothing was lost.
	step(ORDER_STATUS.Preparing, 'Restaurant accepted — cooking and delivering');
	await condition(() => delivered || cancelReason !== undefined);
	if (cancelReason !== undefined) {
		return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);
	}

	// ── 4. Done ───────────────────────────────────────────────────────────
	step(ORDER_STATUS.Delivered, 'Order delivered');
	return snapshot();
}
