/**
 * activities.ts — Temporal activity implementations for the Sandman
 * food-ordering demo.
 *
 * Every activity here runs OUTSIDE the workflow sandbox — in real Node.js
 * with access to I/O, network, and random numbers.  The worker imports this
 * module directly; the workflow file only imports the *types*.
 */

import { ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { activityInfo, heartbeat, log, sleep } from '@temporalio/activity';
import type { CourierInfo, DeliveryAddress, MoneyCents, OrderInput, OrderItem } from './shared.ts';
import { PROMO_CODES } from './shared.ts';

// ---------------------------------------------------------------------------
// Local activity: validateOrder
// ---------------------------------------------------------------------------

/** Validation result from `validateOrder`. */
export type ValidationResult = {
	valid: boolean;
	reason?: string;
};

/**
 * Validates an incoming order — checks items, address, and payment method.
 * Runs as a local activity (same process, no server round-trip).
 * Throws `ApplicationFailure` (non-retryable) for hard validation failures.
 */
export async function validateOrder(input: OrderInput): Promise<ValidationResult> {
	if (!input.items || input.items.length === 0) {
		throw ApplicationFailure.nonRetryable('Order must contain at least one item', 'INVALID_ORDER');
	}
	for (const item of input.items) {
		if (item.quantity < 1) {
			throw ApplicationFailure.nonRetryable(
				`Item ${item.itemId} has invalid quantity ${item.quantity}`,
				'INVALID_ORDER'
			);
		}
		if (item.unitPriceCents < 0) {
			throw ApplicationFailure.nonRetryable(
				`Item ${item.itemId} has negative price`,
				'INVALID_ORDER'
			);
		}
	}
	if (!input.deliveryAddress.street || !input.deliveryAddress.city) {
		throw ApplicationFailure.nonRetryable('Delivery address is incomplete', 'INVALID_ADDRESS');
	}
	log.info('validateOrder: order validated', { orderId: input.orderId });
	return { valid: true };
}

// ---------------------------------------------------------------------------
// Local activity: calculatePricing
// ---------------------------------------------------------------------------

/** Pricing breakdown returned by `calculatePricing`. */
export type PricingResult = {
	subtotalCents: MoneyCents;
	deliveryFeeCents: MoneyCents;
	promoDiscountCents: MoneyCents;
	totalCents: MoneyCents;
};

/**
 * Calculates order pricing including delivery fee and promo discount.
 * Runs as a local activity.  Deterministic — no external I/O.
 */
export async function calculatePricing(
	items: OrderItem[],
	promoCode?: string
): Promise<PricingResult> {
	const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
	const deliveryFeeCents = 299; // flat delivery fee

	let promoDiscountCents = 0;
	if (promoCode) {
		const key = promoCode.toUpperCase() as keyof typeof PROMO_CODES;
		const promo = PROMO_CODES[key];
		if (promo) {
			if ('discountPercent' in promo) {
				promoDiscountCents = Math.floor((subtotalCents * promo.discountPercent) / 100);
			} else {
				promoDiscountCents = Math.min(promo.discountCents, subtotalCents);
			}
		}
	}

	const totalCents = subtotalCents + deliveryFeeCents - promoDiscountCents;
	log.info('calculatePricing: computed', {
		subtotalCents,
		deliveryFeeCents,
		promoDiscountCents,
		totalCents
	});
	return { subtotalCents, deliveryFeeCents, promoDiscountCents, totalCents };
}

// ---------------------------------------------------------------------------
// Local activity: writeAuditLog
// ---------------------------------------------------------------------------

/**
 * Writes an audit log entry.
 * Runs as a local activity for low-latency, in-process logging.
 */
export async function writeAuditLog(entry: {
	orderId: string;
	event: string;
	timestamp: string;
}): Promise<void> {
	log.info('AUDIT', { orderId: entry.orderId, event: entry.event, timestamp: entry.timestamp });
}

// ---------------------------------------------------------------------------
// Local activity: emitMetrics
// ---------------------------------------------------------------------------

/**
 * Emits workflow-phase metrics.
 * Runs as a local activity to avoid the server round-trip for observability.
 */
export async function emitMetrics(metric: {
	orderId: string;
	phase: string;
	durationMs?: number;
}): Promise<void> {
	log.info('METRIC', metric);
}

// ---------------------------------------------------------------------------
// Regular activity: chargePayment
// ---------------------------------------------------------------------------

/** Result of a successful payment charge. */
export type ChargeResult = {
	transactionId: string;
	chargedCents: MoneyCents;
	/**
	 * The attempt number on which the charge ultimately succeeded, taken from
	 * the activity's `activityInfo().attempt`. Reflects real Temporal retries:
	 * 1 on first-try success, 2 if it succeeded after one retry, etc.
	 */
	attempts: number;
};

/**
 * Charges the customer's payment method.
 *
 * - Retries automatically on transient errors (network, gateway timeout).
 * - Throws `ApplicationFailure` (non-retryable) with type `"PAYMENT_DECLINED"`
 *   if the payment method is definitively declined.
 */
export async function chargePayment(
	orderId: string,
	paymentMethod: OrderInput['paymentMethod'],
	amountCents: MoneyCents
): Promise<ChargeResult> {
	const info = activityInfo();
	log.info('chargePayment: attempt', {
		orderId,
		attempt: info.attempt,
		amountCents
	});

	// Simulate a declined payment for wallets with specific provider in test.
	// In real code this would call the payment processor API.
	if (paymentMethod.type === 'wallet' && paymentMethod.provider === 'google-pay') {
		// Simulate a hard decline (for non-retryable test)
		throw ApplicationFailure.nonRetryable('Payment method declined by issuer', 'PAYMENT_DECLINED');
	}

	// Simulate transient failure on first attempt to exercise retry
	if (info.attempt === 1 && paymentMethod.type === 'card' && paymentMethod.last4 === '0000') {
		throw new Error('Gateway timeout — will retry');
	}

	const transactionId = `txn-${orderId}-${info.attempt}`;
	log.info('chargePayment: success', { orderId, transactionId, attempts: info.attempt });
	return { transactionId, chargedCents: amountCents, attempts: info.attempt };
}

// ---------------------------------------------------------------------------
// Regular activity: refundPayment  (saga compensation)
// ---------------------------------------------------------------------------

/** Result of a payment refund. */
export type RefundResult = {
	refundId: string;
	refundedCents: MoneyCents;
};

/**
 * Refunds the customer's payment as part of saga compensation.
 * Has a permissive retry policy — refunds must eventually succeed.
 */
export async function refundPayment(
	orderId: string,
	amountCents: MoneyCents
): Promise<RefundResult> {
	log.info('refundPayment: issuing refund', { orderId, amountCents });
	const refundId = `ref-${orderId}`;
	return { refundId, refundedCents: amountCents };
}

// ---------------------------------------------------------------------------
// Regular activity: notifyRestaurant
// ---------------------------------------------------------------------------

/** Result of restaurant notification. */
export type NotifyResult = {
	notificationId: string;
	sentAt: string;
};

/**
 * Notifies the restaurant of a new order.
 * Retries automatically on transient failures.
 */
export async function notifyRestaurant(
	orderId: string,
	restaurantId: string,
	items: OrderItem[]
): Promise<NotifyResult> {
	log.info('notifyRestaurant', { orderId, restaurantId, itemCount: items.length });
	const notificationId = `notif-${orderId}`;
	return { notificationId, sentAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Regular activity: assignCourier
// ---------------------------------------------------------------------------

/**
 * Assigns a courier for the delivery.
 * Returns courier info including a generated courierId.
 */
export async function assignCourier(
	orderId: string,
	deliveryAddress: DeliveryAddress
): Promise<CourierInfo> {
	log.info('assignCourier', { orderId, city: deliveryAddress.city });
	return {
		courierId: `courier-${orderId}`,
		name: 'Alex Courier',
		etaMinutes: 25
	};
}

// ---------------------------------------------------------------------------
// Regular activity: releaseCourier  (saga compensation)
// ---------------------------------------------------------------------------

/**
 * Releases a previously assigned courier back to the pool.
 * Used in saga compensation when an order is cancelled after courier assignment.
 */
export async function releaseCourier(orderId: string, courierId: string): Promise<void> {
	log.info('releaseCourier', { orderId, courierId });
}

// ---------------------------------------------------------------------------
// Regular activity: trackCourier  (heartbeating, cancellable)
// ---------------------------------------------------------------------------

/**
 * Tracks a courier's location by heartbeating every `heartbeatIntervalMs`
 * milliseconds.  Runs indefinitely until cancelled via a `CancellationScope`.
 *
 * Cancellation is propagated through the heartbeat mechanism: once the
 * Temporal server marks the activity cancelled, the next `sleep()` call will
 * throw `CancelledFailure`.
 */
export async function trackCourier(options: {
	courierId: string;
	orderId: string;
	heartbeatIntervalMs?: number;
	/**
	 * Maximum heartbeat ticks before the activity exits naturally.
	 * Undefined (default) loops until the activity is cancelled.
	 * Set in tests to allow the SLA timer to fire via time-skip once the
	 * activity has completed.
	 */
	maxTicks?: number;
}): Promise<void> {
	const interval = options.heartbeatIntervalMs ?? 5_000;
	const info = activityInfo();
	log.info('trackCourier: starting', { courierId: options.courierId, orderId: options.orderId });

	// Restore previous heartbeat position on retry
	const startTick: number = (info.heartbeatDetails as number | undefined) ?? 0;
	let tick = startTick;

	try {
		while (options.maxTicks === undefined || tick < options.maxTicks) {
			heartbeat(tick);
			tick++;
			log.debug('trackCourier: heartbeat', { tick, courierId: options.courierId });
			// sleep throws CancelledFailure if the activity is cancelled
			await sleep(interval);
		}
		log.info('trackCourier: maxTicks reached — exiting naturally', {
			tick,
			courierId: options.courierId
		});
	} catch (err) {
		if (err instanceof CancelledFailure) {
			log.info('trackCourier: cancelled at tick', { tick, courierId: options.courierId });
			throw err; // Re-throw so the framework cleans up correctly
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Regular activity: dispatchCourier
// ---------------------------------------------------------------------------

/**
 * Dispatches the assigned courier to start delivery.
 */
export async function dispatchCourier(
	orderId: string,
	courierId: string,
	deliveryAddress: DeliveryAddress
): Promise<{ dispatchedAt: string }> {
	log.info('dispatchCourier', { orderId, courierId, city: deliveryAddress.city });
	return { dispatchedAt: new Date().toISOString() };
}
