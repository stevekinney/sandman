/**
 * activities.ts — the workflow's side effects.
 *
 * Temporal workflows must be deterministic, so anything unpredictable —
 * network calls, payments, randomness — lives here, in *activities*. An
 * activity is just an async function. The worker runs it in plain Node.js
 * (full I/O access), records the result in the workflow's history, and a
 * replaying workflow reuses that recorded result instead of running the
 * activity again.
 *
 * If an activity throws, Temporal retries it automatically using the retry
 * policy defined in workflow.ts. You never write a retry loop.
 *
 * These implementations are simulations — each one logs what a real system
 * would do. Watch the worker logs while an order runs to see them fire.
 */

import { ApplicationFailure, activityInfo, log } from '@temporalio/activity';
import type { MoneyCents, OrderItem } from './shared.ts';

/** What a successful charge returns to the workflow. */
export type ChargeResult = {
	transactionId: string;
	/** Which attempt finally succeeded — 1 on the first try, 2 after one retry, etc. */
	attempts: number;
};

/**
 * Charge the customer's card.
 *
 * Two magic card numbers make failure easy to demo:
 *  - '0000' — the first attempt throws a fake gateway timeout. Temporal
 *    retries automatically, and the second attempt succeeds. Watch the event
 *    history: the workflow itself never notices.
 *  - '9999' — the card is declined. A decline is permanent, so we throw a
 *    NON-retryable failure; the retry policy is skipped and the workflow's
 *    catch block handles it.
 *
 * Try: change '0000' to '4242' (the default demo card) — now every new
 * order's first charge attempt fails, and Temporal retries it for you.
 */
export async function chargePayment(
	orderId: string,
	cardLast4: string,
	amountCents: MoneyCents
): Promise<ChargeResult> {
	// activityInfo() tells an activity about its own execution — including
	// which retry attempt this is.
	const { attempt } = activityInfo();
	log.info('chargePayment', { orderId, amountCents, attempt });

	if (cardLast4 === '9999') {
		throw ApplicationFailure.nonRetryable('Card declined by issuer', 'PaymentDeclined');
	}

	if (cardLast4 === '0000' && attempt === 1) {
		throw new Error('Payment gateway timed out — Temporal will retry this automatically');
	}

	return { transactionId: `txn-${orderId}-${attempt}`, attempts: attempt };
}

/** Tell the restaurant about the order (in real life: a POS integration or webhook). */
export async function notifyRestaurant(orderId: string, items: OrderItem[]): Promise<void> {
	log.info('notifyRestaurant', { orderId, itemCount: items.length });
}

/**
 * Refund the customer. The workflow calls this when the restaurant never
 * accepts (the durable timer fires) or the customer cancels after being
 * charged — money moved, so it must move back.
 */
export async function refundPayment(orderId: string, amountCents: MoneyCents): Promise<void> {
	log.info('refundPayment', { orderId, amountCents });
}
