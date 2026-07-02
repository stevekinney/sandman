/**
 * delivery-workflow.ts — the child workflow that owns the delivery leg.
 *
 * Once food is ready, order-workflow.ts *spawns* this as a child workflow.
 * A child is a full workflow in its own right: it has its own event history,
 * its own entry in the Temporal Web UI, and its own signals — while the
 * parent stays subscribed to its result. That is workflow composition: big
 * processes built out of small, independently observable ones.
 */

import {
	CancellationScope,
	condition,
	continueAsNew,
	executeChild,
	isCancellation,
	setHandler,
	sleep,
	workflowInfo
} from '@temporalio/workflow';
import { trackCourier } from './definitions.ts';
import { deliveryCompletedSignal } from './signals.ts';
import { TASK_QUEUE } from './shared.ts';
// Type-only: the child is started by its registered name so this file and
// order-workflow.ts never form a runtime import cycle.
import type { orderFoodWorkflow } from './order-workflow.ts';

/**
 * Tracks a courier until the delivery is confirmed (or the SLA expires).
 *
 * Two things run at once here:
 *  1. `trackCourier` — a long-running activity that heartbeats the courier's
 *     position. It runs inside a CancellationScope so we can stop it cleanly.
 *  2. `condition(...)` — parks the workflow until the `deliveryCompleted`
 *     signal arrives, or the SLA timer fires. Both the wait and the timer are
 *     durable: they survive worker crashes.
 *
 * Try: shrink the SLA fallback `?? '2h'` to `'30s'` — complete the delivery
 * too slowly and the result flips to `deliveredOnTime: false`.
 */
export async function deliveryWorkflow(input: DeliveryInput): Promise<DeliveryResult> {
	let deliveredOnTime = false;
	setHandler(deliveryCompletedSignal, () => {
		deliveredOnTime = true;
	});

	// Run the tracker in a cancellable scope: when delivery finishes (or the
	// SLA expires) we cancel tracking instead of letting it run for hours.
	const trackingScope = new CancellationScope({ cancellable: true });
	const tracking = trackingScope.run(() =>
		trackCourier({
			courierId: input.courierId,
			orderId: input.orderId,
			heartbeatIntervalMs: input.heartbeatIntervalMs ?? 5_000,
			maxTicks: input.maxTrackerTicks
		})
	);

	let trackingError: unknown;
	try {
		// Durable wait: resumes on the deliveryCompleted signal or the SLA timer.
		await condition(() => deliveredOnTime, input.slaTimeout ?? '2h');
	} finally {
		trackingScope.cancel();
		try {
			await tracking;
		} catch (err) {
			// Cancellation is the expected way the tracker ends — only a real
			// failure should surface to the caller.
			if (!isCancellation(err)) trackingError = err;
		}
	}
	if (trackingError) throw trackingError;
	return { deliveredOnTime, courierId: input.courierId };
}

/**
 * A recurring order, expressed as a workflow that never really ends.
 *
 * Each cycle places one order (as a child), sleeps a durable week, then calls
 * `continueAsNew` — which atomically starts a fresh run with new arguments
 * and a clean history. This is how Temporal models subscriptions, cron-like
 * jobs, and any "forever" process without unbounded history growth.
 */
export async function subscriptionWorkflow(input: SubscriptionInput): Promise<void> {
	const info = workflowInfo();
	if (input.maxCycles && input.cycleCount >= input.maxCycles) return;
	const orderId = `${info.workflowId}-cycle-${input.cycleCount}`;
	await executeChild<typeof orderFoodWorkflow>('orderFoodWorkflow', {
		workflowId: orderId,
		args: [{ ...input.baseOrder, orderId }],
		taskQueue: TASK_QUEUE
	});
	// A durable timer: the workflow can sleep for a week and survive any number
	// of worker restarts in between.
	await sleep('7d');
	await continueAsNew<typeof subscriptionWorkflow>({
		...input,
		cycleCount: input.cycleCount + 1,
		lastOrderId: orderId
	});
}

/** Tiny workflow used by tests to prove the time-skipping test server works. */
export async function timeSkipSanity(): Promise<string> {
	await sleep('1h');
	return 'ok';
}
