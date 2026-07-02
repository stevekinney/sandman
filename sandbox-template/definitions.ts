/**
 * definitions.ts — how the workflow talks to the outside world.
 *
 * Temporal workflows must be deterministic, so anything unpredictable
 * (network calls, payments, randomness) runs in an *activity* — a plain async
 * function executed by the worker, outside the workflow's replayable code.
 * This file wires those activities up, along with the queries and updates
 * that let the outside world read and change a running workflow.
 *
 * It is the best place to experiment with retry policies and timeouts:
 * everything here is a knob, and the workflow code never has to change.
 */

import {
	ActivityCancellationType,
	defineQuery,
	defineUpdate,
	proxyActivities,
	proxyLocalActivities
} from '@temporalio/workflow';
import { defineSearchAttributeKey } from '@temporalio/common';
import type * as activities from './activities.ts';

/**
 * Regular activities — each call is recorded in workflow history, so a replay
 * never re-runs one that already completed. If an activity throws, Temporal
 * retries it *automatically* using this policy; the workflow never contains a
 * retry loop.
 *
 * Try: set `maximumAttempts` to 1 and trigger the flaky payment card (see
 * activities.ts) — the first transient failure now cancels the order instead
 * of retrying. Or stretch `initialInterval` to '10s' and watch the retry
 * pause in the event stream.
 */
export const {
	chargePayment,
	refundPayment,
	notifyRestaurant,
	assignCourier,
	releaseCourier,
	dispatchCourier
} = proxyActivities<typeof activities>({
	// How long one attempt may run before Temporal times it out and retries.
	startToCloseTimeout: '30s',
	retry: {
		initialInterval: '1s',
		backoffCoefficient: 2,
		maximumAttempts: 5,
		// Some failures should never be retried — a declined card stays declined.
		// Throwing ApplicationFailure with one of these types skips the policy.
		nonRetryableErrorTypes: ['PAYMENT_DECLINED', 'INVALID_ORDER', 'INVALID_ADDRESS']
	}
});

/**
 * The courier tracker is long-running, so it *heartbeats*: a periodic ping
 * that tells the server "still alive". Miss the heartbeat window and Temporal
 * declares that attempt dead and schedules a retry; heartbeats are also how
 * cancellation reaches a running activity.
 *
 * The retries matter for the chaos buttons: kill the worker (or the whole
 * server) for longer than the heartbeat window and the tracker's first
 * attempt times out — the retry lets tracking resume after recovery instead
 * of failing the delivery.
 *
 * Try: shrink `heartbeatTimeout` to '2s' — if the tracker ever stalls longer
 * than that, Temporal kills that attempt and starts another.
 */
export const { trackCourier } = proxyActivities<Pick<typeof activities, 'trackCourier'>>({
	startToCloseTimeout: '2h',
	heartbeatTimeout: '30s',
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 3 }
});

/**
 * Local activities run in the same process as the workflow task — no round
 * trip to the Temporal server. Cheaper, but with weaker durability guarantees:
 * the classic trade-off for fast, low-stakes work like audit logs and metrics.
 */
export const { validateOrder, calculatePricing, writeAuditLog, emitMetrics } = proxyLocalActivities<
	typeof activities
>({
	startToCloseTimeout: '10s',
	retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['INVALID_ORDER', 'INVALID_ADDRESS'] }
});

/**
 * Queries — read-only windows into a *running* workflow. Handling one never
 * writes history or advances execution; the workflow answers from its current
 * in-memory state.
 */
export const getStatusQuery = defineQuery<OrderSnapshot>('getStatus');
export const getTimelineQuery = defineQuery<TimelineEntry[]>('getTimeline');

/**
 * Updates — the read-write counterpart to queries. An update runs a
 * synchronous *validator* first: reject there and nothing is written to
 * history, as if the request never happened. Accept, and the handler mutates
 * workflow state durably. The handlers (and their validators) live in
 * order-workflow.ts.
 */
export const updateDeliveryAddressUpdate = defineUpdate<
	UpdateDeliveryAddressResult,
	[UpdateDeliveryAddressInput]
>('updateDeliveryAddress');
export const applyPromoCodeUpdate = defineUpdate<ApplyPromoCodeResult, [ApplyPromoCodeInput]>(
	'applyPromoCode'
);

/**
 * Search Attributes — indexed key/values the workflow "upserts" as it runs,
 * making executions searchable across the whole cluster ("every order for
 * kitchen-44 that is still IN_DELIVERY"). The List Visibility control and the
 * Temporal Web UI search box both query these.
 */
export const orderStatusSearchAttributeKey = defineSearchAttributeKey('OrderStatus', 'KEYWORD');
export const customerTierSearchAttributeKey = defineSearchAttributeKey('CustomerTier', 'KEYWORD');
export const restaurantIdSearchAttributeKey = defineSearchAttributeKey('RestaurantId', 'KEYWORD');
