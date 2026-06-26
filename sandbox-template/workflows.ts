/**
 * workflows.ts — Temporal workflow definitions for the Sandman food-ordering
 * demo.
 *
 * DETERMINISM RULES (enforced here, never bypassed):
 * - No Date.now() or Math.random() — the SDK overrides Date deterministically
 *   inside the workflow sandbox; Math.random() must use workflowRandom()
 * - No raw I/O or Node built-ins
 * - No direct imports of activities (use `import type` + proxyActivities)
 * - Order IDs generated via uuid4() from @temporalio/workflow
 */

import {
	ActivityCancellationType,
	ApplicationFailure,
	CancellationScope,
	allHandlersFinished,
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	defineUpdate,
	executeChild,
	isCancellation,
	log,
	proxyActivities,
	proxyLocalActivities,
	setHandler,
	sleep,
	startChild,
	workflowInfo
} from '@temporalio/workflow';
import type * as acts from './activities.ts';
import type {
	AddTipSignal,
	ApplyPromoCodeInput,
	ApplyPromoCodeResult,
	CancelOrderSignal,
	CompensationRecord,
	CourierInfo,
	CourierLocationUpdate,
	DeliveryInput,
	DeliveryResult,
	FoodReadySignal,
	MoneyCents,
	OrderInput,
	OrderSnapshot,
	RestaurantAcceptedSignal,
	RestaurantRejectedSignal,
	SubscriptionInput,
	TimelineEntry,
	UpdateDeliveryAddressInput,
	UpdateDeliveryAddressResult
} from './shared.ts';
import { ORDER_STATUS, PROMO_CODES, TASK_QUEUE } from './shared.ts';

// ---------------------------------------------------------------------------
// Activity proxies
// ---------------------------------------------------------------------------

/**
 * Regular activities — run in the worker process, support heartbeats.
 * Use these for I/O-bound work and long-running operations.
 */
const {
	chargePayment,
	refundPayment,
	notifyRestaurant,
	assignCourier,
	releaseCourier,
	dispatchCourier
} = proxyActivities<typeof acts>({
	startToCloseTimeout: '30s',
	retry: {
		initialInterval: '1s',
		backoffCoefficient: 2,
		maximumInterval: '30s',
		maximumAttempts: 5,
		nonRetryableErrorTypes: ['PAYMENT_DECLINED', 'INVALID_ORDER', 'INVALID_ADDRESS']
	}
});

/**
 * Courier-tracking activity — long-running heartbeat loop.
 *
 * Uses WAIT_CANCELLATION_COMPLETED so the workflow does not proceed until the
 * activity has actually reported its cancellation to the server.  This prevents
 * "zombie" activity tasks in the time-skipping test environment that would
 * otherwise block time-skip advancement and cause flaky timer tests.
 */
const { trackCourier } = proxyActivities<Pick<typeof acts, 'trackCourier'>>({
	startToCloseTimeout: '2h',
	heartbeatTimeout: '30s',
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 1 }
});

/**
 * Local activities — run in the same process without a server round-trip.
 * Use these for fast, CPU-bound deterministic work (validation, pricing,
 * audit log, metrics).
 */
const { validateOrder, calculatePricing, writeAuditLog, emitMetrics } = proxyLocalActivities<
	typeof acts
>({
	startToCloseTimeout: '10s',
	retry: {
		initialInterval: '100ms',
		maximumAttempts: 3,
		nonRetryableErrorTypes: ['INVALID_ORDER', 'INVALID_ADDRESS']
	}
});

// ---------------------------------------------------------------------------
// Signal definitions (exported for client/test use)
// ---------------------------------------------------------------------------

/** Signal: request order cancellation. */
export const cancelOrderSignal = defineSignal<[CancelOrderSignal]>('cancelOrder');
/** Signal: restaurant accepted the order. */
export const restaurantAcceptedSignal =
	defineSignal<[RestaurantAcceptedSignal]>('restaurantAccepted');
/** Signal: restaurant rejected the order. */
export const restaurantRejectedSignal =
	defineSignal<[RestaurantRejectedSignal]>('restaurantRejected');
/** Signal: kitchen preparation is complete. */
export const foodReadySignal = defineSignal<[FoodReadySignal]>('foodReady');
/** Signal: courier GPS location update. */
export const courierLocationUpdateSignal =
	defineSignal<[CourierLocationUpdate]>('courierLocationUpdate');
/** Signal: customer adds a tip. */
export const addTipSignal = defineSignal<[AddTipSignal]>('addTip');

// ---------------------------------------------------------------------------
// Query definitions (exported for client/test use)
// ---------------------------------------------------------------------------

/** Query: return a live snapshot of the order state. */
export const getStatusQuery = defineQuery<OrderSnapshot>('getStatus');
/** Query: return the annotated event timeline. */
export const getTimelineQuery = defineQuery<TimelineEntry[]>('getTimeline');

// ---------------------------------------------------------------------------
// Update definitions (exported for client/test use)
// ---------------------------------------------------------------------------

/** Update: change the delivery address (rejected after IN_DELIVERY). */
export const updateDeliveryAddressUpdate = defineUpdate<
	UpdateDeliveryAddressResult,
	[UpdateDeliveryAddressInput]
>('updateDeliveryAddress');

/** Update: apply a promo code and get a new total. */
export const applyPromoCodeUpdate = defineUpdate<ApplyPromoCodeResult, [ApplyPromoCodeInput]>(
	'applyPromoCode'
);

// ---------------------------------------------------------------------------
// Delivery workflow signals
// ---------------------------------------------------------------------------

/** Signal sent to `deliveryWorkflow` to mark the order as delivered. */
export const deliveryCompletedSignal = defineSignal('deliveryCompleted');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp using the workflow-controlled deterministic clock. */
function now(): string {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// orderFoodWorkflow
// ---------------------------------------------------------------------------

/**
 * Primary food-ordering workflow.
 *
 * Demonstrates: activities + retry, non-retryable failure, saga compensation,
 * signals, queries, updates + validators, durable timers, child workflows,
 * heartbeat + cancellation, continue-as-new, search attributes, local
 * activities, replay safety.
 *
 * @param input - order parameters
 * @param seed - optional snapshot to resume from after continueAsNew
 */
export async function orderFoodWorkflow(
	input: OrderInput,
	seed?: OrderSnapshot
): Promise<OrderSnapshot> {
	// -----------------------------------------------------------------------
	// Mutable workflow state
	// -----------------------------------------------------------------------
	let status = seed?.status ?? ORDER_STATUS.Created;
	let currentInput: OrderInput = seed?.input ?? input;
	let subtotalCents: MoneyCents = seed?.subtotalCents ?? 0;
	let deliveryFeeCents: MoneyCents = seed?.deliveryFeeCents ?? 299;
	let tipCents: MoneyCents = seed?.tipCents ?? 0;
	let promoDiscountCents: MoneyCents = seed?.promoDiscountCents ?? 0;
	let totalCents: MoneyCents = seed?.totalCents ?? 0;
	const attemptCounts: Record<string, number> = seed?.attemptCounts ?? {};
	const compensationRecords: CompensationRecord[] = seed?.compensations ?? [];
	let courier: CourierInfo | undefined = seed?.courier;
	let locationUpdateCount = seed?.locationUpdateCount ?? 0;
	const restaurantDeadline = seed?.restaurantDeadline;
	let deliveryDeadline: string | undefined = seed?.deliveryDeadline;
	const startedAt = seed?.startedAt ?? now();
	let updatedAt = seed?.updatedAt ?? startedAt;
	let completedAt: string | undefined = seed?.completedAt;
	let appliedPromoCode: string | undefined = seed?.appliedPromoCode;
	let continueAsNewPending = false;
	/** Stores the active delivery CancellationScope so cancelOrderSignal can abort it. */
	let deliveryCancellationScope: CancellationScope | null = null;
	const timeline: TimelineEntry[] = [];

	// Compensation stack — each forward step pushes its rollback function
	const compensations: Array<() => Promise<void>> = [];

	// Signal state flags
	let cancelRequested = false;
	let cancelReason = '';
	let restaurantAccepted = false;
	let restaurantRejected = false;
	let restaurantRejectedReason = '';
	let foodReady = false;

	// -----------------------------------------------------------------------
	// Timeline helper
	// -----------------------------------------------------------------------
	function addTimeline(description: string, featureId?: string): void {
		timeline.push({
			index: timeline.length,
			timestamp: now(),
			description,
			status,
			featureId
		});
		updatedAt = now();
	}

	// -----------------------------------------------------------------------
	// Snapshot builder
	// -----------------------------------------------------------------------
	function buildSnapshot(): OrderSnapshot {
		return {
			status,
			input: currentInput,
			subtotalCents,
			deliveryFeeCents,
			tipCents,
			promoDiscountCents,
			totalCents,
			attemptCounts,
			compensations: compensationRecords,
			courier,
			locationUpdateCount,
			restaurantDeadline,
			deliveryDeadline,
			startedAt,
			updatedAt,
			completedAt,
			appliedPromoCode,
			continueAsNewPending,
			searchAttributes: {
				OrderStatus: status,
				CustomerTier: currentInput.customerTier,
				RestaurantId: currentInput.restaurantId
			}
		};
	}

	// -----------------------------------------------------------------------
	// Compensation runner
	// -----------------------------------------------------------------------
	async function runCompensations(): Promise<void> {
		// Execute in reverse order (LIFO)
		const stack = [...compensations].reverse();
		for (const comp of stack) {
			try {
				await comp();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				compensationRecords.push({
					action: 'compensation-error',
					timestamp: now(),
					ok: false,
					errorMessage: msg
				});
				log.error('Compensation step failed', { error: msg });
			}
		}
	}

	// -----------------------------------------------------------------------
	// Status transition helper
	// -----------------------------------------------------------------------
	function transition(next: (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS]): void {
		status = next;
		updatedAt = now();
		// NOTE: upsertSearchAttributes requires custom SA registration on the
		// Temporal server.  For the dev sandbox (temporal server start-dev),
		// register them with: `temporal operator search-attribute create
		// --name OrderStatus --type Keyword --name CustomerTier --type Keyword
		// --name RestaurantId --type Keyword`.
		// In tests we assert via the OrderSnapshot.searchAttributes mirror instead.
	}

	// -----------------------------------------------------------------------
	// Signal handlers (registered once, active throughout)
	// -----------------------------------------------------------------------

	setHandler(cancelOrderSignal, (payload: CancelOrderSignal) => {
		if (
			status !== ORDER_STATUS.Cancelled &&
			status !== ORDER_STATUS.Refunded &&
			status !== ORDER_STATUS.Delivered
		) {
			cancelRequested = true;
			cancelReason = payload.reason;
			addTimeline(`Cancel requested: ${payload.reason}`, 'signals');
			// If the delivery phase is active, abort it immediately.
			deliveryCancellationScope?.cancel();
		}
	});

	setHandler(restaurantAcceptedSignal, (payload: RestaurantAcceptedSignal) => {
		restaurantAccepted = true;
		addTimeline(`Restaurant accepted — prep ~${payload.estimatedPrepMinutes}min`, 'signals');
	});

	setHandler(restaurantRejectedSignal, (payload: RestaurantRejectedSignal) => {
		restaurantRejected = true;
		restaurantRejectedReason = payload.reason;
		addTimeline(`Restaurant rejected: ${payload.reason}`, 'signals');
	});

	setHandler(foodReadySignal, () => {
		foodReady = true;
		addTimeline('Food ready for pickup', 'signals');
	});

	setHandler(courierLocationUpdateSignal, (location: CourierLocationUpdate) => {
		if (courier) {
			courier = { ...courier, location };
		}
		locationUpdateCount++;
		addTimeline('Courier location updated', 'heartbeats-cancellation');
	});

	setHandler(addTipSignal, (payload: AddTipSignal) => {
		tipCents += payload.amountCents;
		totalCents += payload.amountCents;
		addTimeline(`Tip added: ${payload.amountCents} cents`, 'signals');
	});

	// -----------------------------------------------------------------------
	// Query handlers
	// -----------------------------------------------------------------------

	setHandler(getStatusQuery, buildSnapshot);
	setHandler(getTimelineQuery, () => [...timeline]);

	// -----------------------------------------------------------------------
	// Update handlers (with validators)
	// -----------------------------------------------------------------------

	setHandler(
		updateDeliveryAddressUpdate,
		(payload: UpdateDeliveryAddressInput): UpdateDeliveryAddressResult => {
			const same =
				JSON.stringify(currentInput.deliveryAddress) === JSON.stringify(payload.newAddress);
			if (!same) {
				currentInput = { ...currentInput, deliveryAddress: payload.newAddress };
				addTimeline('Delivery address updated', 'updates-validators');
			}
			return { updated: !same, effectiveAddress: currentInput.deliveryAddress };
		},
		{
			validator: (payload: UpdateDeliveryAddressInput) => {
				if (status === ORDER_STATUS.InDelivery || status === ORDER_STATUS.Delivered) {
					throw ApplicationFailure.nonRetryable('order-already-in-delivery', 'UPDATE_REJECTED');
				}
				if (status === ORDER_STATUS.Cancelled || status === ORDER_STATUS.Refunded) {
					throw ApplicationFailure.nonRetryable('order-cancelled', 'UPDATE_REJECTED');
				}
				// Suppress "unused variable" for the payload — TypeScript requires it
				void payload;
			}
		}
	);

	setHandler(
		applyPromoCodeUpdate,
		(payload: ApplyPromoCodeInput): ApplyPromoCodeResult => {
			const key = payload.code.toUpperCase() as keyof typeof PROMO_CODES;
			const promo = PROMO_CODES[key];
			let discountCents: MoneyCents;
			if ('discountPercent' in promo) {
				discountCents = Math.floor((subtotalCents * promo.discountPercent) / 100);
			} else {
				discountCents = Math.min(promo.discountCents, subtotalCents);
			}
			promoDiscountCents = discountCents;
			appliedPromoCode = payload.code;
			totalCents = subtotalCents + deliveryFeeCents + tipCents - promoDiscountCents;
			const newTotalCents = totalCents;
			addTimeline(`Promo code applied: ${payload.code}`, 'updates-validators');
			return { discountCents, newTotalCents, description: promo.description };
		},
		{
			validator: (payload: ApplyPromoCodeInput) => {
				if (status === ORDER_STATUS.Delivered) {
					throw ApplicationFailure.nonRetryable('order-already-completed', 'UPDATE_REJECTED');
				}
				if (status === ORDER_STATUS.Cancelled || status === ORDER_STATUS.Refunded) {
					throw ApplicationFailure.nonRetryable('order-cancelled', 'UPDATE_REJECTED');
				}
				if (appliedPromoCode) {
					throw ApplicationFailure.nonRetryable('code-already-used', 'UPDATE_REJECTED');
				}
				const key = payload.code.toUpperCase() as string;
				if (!(key in PROMO_CODES)) {
					throw ApplicationFailure.nonRetryable('invalid-code', 'UPDATE_REJECTED');
				}
			}
		}
	);

	// -----------------------------------------------------------------------
	// If resuming from a seed (after continueAsNew), fast-forward to the
	// delivery phase, re-registering courier tracking.
	// -----------------------------------------------------------------------
	if (seed && seed.status === ORDER_STATUS.InDelivery && seed.courier) {
		// Restore courier tracking phase — jump directly to delivery
		addTimeline('Resumed from continueAsNew', 'continue-as-new');
		transition(ORDER_STATUS.InDelivery);
		try {
			await runDeliveryPhase();
		} catch (err) {
			if (isCancellation(err)) {
				return buildSnapshot(); // already CANCELLED inside runDeliveryPhase
			}
			throw err;
		}
		if (cancelRequested) {
			await runCompensations();
			transition(ORDER_STATUS.Cancelled);
			completedAt = now();
			return buildSnapshot();
		}
		completedAt = now();
		transition(ORDER_STATUS.Delivered);
		addTimeline('Order delivered', 'durable-recovery');
		await writeAuditLog({ orderId: currentInput.orderId, event: 'delivered', timestamp: now() });
		return buildSnapshot();
	}

	// -----------------------------------------------------------------------
	// PHASE 1: VALIDATING
	// -----------------------------------------------------------------------
	transition(ORDER_STATUS.Validating);
	addTimeline('Validating order', 'local-activities');

	await validateOrder(currentInput);
	const pricing = await calculatePricing(currentInput.items, currentInput.promoCode);
	subtotalCents = pricing.subtotalCents;
	deliveryFeeCents = pricing.deliveryFeeCents;
	promoDiscountCents = pricing.promoDiscountCents;
	totalCents = pricing.totalCents;
	if (currentInput.promoCode) {
		appliedPromoCode = currentInput.promoCode;
	}
	addTimeline('Pricing calculated', 'local-activities');
	await emitMetrics({ orderId: currentInput.orderId, phase: 'validated' });

	// -----------------------------------------------------------------------
	// PHASE 2: Charge payment (retryable; non-retryable on hard decline)
	// -----------------------------------------------------------------------
	addTimeline('Charging payment', 'activities-retry');

	try {
		attemptCounts['chargePayment'] = (attemptCounts['chargePayment'] ?? 0) + 1;
		const charge = await chargePayment(
			currentInput.orderId,
			currentInput.paymentMethod,
			totalCents
		);
		addTimeline(`Payment charged: txn ${charge.transactionId}`, 'activities-retry');
		log.info('Payment charged', { transactionId: charge.transactionId });
	} catch (err) {
		// Non-retryable: PAYMENT_DECLINED — run saga immediately
		const failure = err instanceof ApplicationFailure ? err : undefined;
		const isDeclined = failure?.nonRetryable === true || failure?.type === 'PAYMENT_DECLINED';
		addTimeline(
			`Payment failed${isDeclined ? ' (non-retryable)' : ''}`,
			isDeclined ? 'non-retryable-failure' : 'activities-retry'
		);
		transition(ORDER_STATUS.Cancelled);
		completedAt = now();
		return buildSnapshot();
	}

	// Register refund as the first compensation
	compensations.push(async () => {
		try {
			await refundPayment(currentInput.orderId, totalCents + tipCents);
			compensationRecords.push({
				action: 'refund-payment',
				timestamp: now(),
				ok: true
			});
		} catch (err) {
			compensationRecords.push({
				action: 'refund-payment',
				timestamp: now(),
				ok: false,
				errorMessage: err instanceof Error ? err.message : String(err)
			});
		}
	});

	// -----------------------------------------------------------------------
	// PHASE 3: AWAITING_RESTAURANT
	// -----------------------------------------------------------------------
	transition(ORDER_STATUS.AwaitingRestaurant);
	addTimeline('Awaiting restaurant acceptance', 'timers-durable-sleep');

	await notifyRestaurant(currentInput.orderId, currentInput.restaurantId, currentInput.items);
	addTimeline('Restaurant notified', 'activities-retry');

	const timeoutMinutes = currentInput.restaurantAcceptTimeoutMinutes ?? 10;
	const timeoutDuration = `${timeoutMinutes}m`;

	const restaurantResponded = await condition(
		() => restaurantAccepted || restaurantRejected || cancelRequested,
		timeoutDuration
	);

	if (!restaurantResponded || cancelRequested) {
		// Timeout or manual cancel
		addTimeline(
			restaurantResponded ? 'Order cancelled during restaurant wait' : 'Restaurant accept timeout',
			'timers-durable-sleep'
		);
		await runCompensations();
		transition(ORDER_STATUS.Refunded);
		completedAt = now();
		return buildSnapshot();
	}

	if (restaurantRejected) {
		addTimeline(`Restaurant rejected: ${restaurantRejectedReason}`, 'signals');
		await runCompensations();
		transition(ORDER_STATUS.Cancelled);
		completedAt = now();
		return buildSnapshot();
	}

	// -----------------------------------------------------------------------
	// PHASE 4: PREPARING
	// -----------------------------------------------------------------------
	transition(ORDER_STATUS.Preparing);
	addTimeline('Restaurant preparing order', 'signals');

	await condition(() => foodReady || cancelRequested);

	if (cancelRequested) {
		addTimeline(`Order cancelled during preparation: ${cancelReason}`, 'saga-compensation');
		await runCompensations();
		transition(ORDER_STATUS.Cancelled);
		completedAt = now();
		return buildSnapshot();
	}

	// -----------------------------------------------------------------------
	// PHASE 5: AWAITING_COURIER
	// -----------------------------------------------------------------------
	transition(ORDER_STATUS.AwaitingCourier);
	addTimeline('Assigning courier', 'child-workflow');

	courier = await assignCourier(currentInput.orderId, currentInput.deliveryAddress);
	addTimeline(`Courier assigned: ${courier.name}`, 'child-workflow');

	// Register courier release as compensation
	const assignedCourierId = courier.courierId;
	compensations.push(async () => {
		try {
			await releaseCourier(currentInput.orderId, assignedCourierId);
			compensationRecords.push({
				action: 'release-courier',
				timestamp: now(),
				ok: true
			});
		} catch (err) {
			compensationRecords.push({
				action: 'release-courier',
				timestamp: now(),
				ok: false,
				errorMessage: err instanceof Error ? err.message : String(err)
			});
		}
	});

	await dispatchCourier(currentInput.orderId, courier.courierId, currentInput.deliveryAddress);
	addTimeline('Courier dispatched', 'child-workflow');

	// Guard: if cancelOrder arrived while Phase 5 was executing (before the
	// deliveryCancellationScope existed), honour it now — before ever creating
	// the delivery child and starting trackCourier.
	if (cancelRequested) {
		addTimeline(`Order cancelled after dispatch: ${cancelReason}`, 'saga-compensation');
		await runCompensations();
		transition(ORDER_STATUS.Cancelled);
		completedAt = now();
		return buildSnapshot();
	}

	// -----------------------------------------------------------------------
	// PHASE 6: IN_DELIVERY (child workflow)
	// -----------------------------------------------------------------------
	transition(ORDER_STATUS.InDelivery);
	addTimeline('Delivery in progress', 'child-workflow');

	// Delivery SLA — 2 hours before escalation
	const slaHours = 2;
	deliveryDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

	try {
		await runDeliveryPhase();
	} catch (err) {
		if (isCancellation(err)) {
			return buildSnapshot(); // already CANCELLED inside runDeliveryPhase
		}
		throw err;
	}

	// If cancel arrived exactly as delivery completed, honour the cancel.
	if (cancelRequested) {
		await runCompensations();
		transition(ORDER_STATUS.Cancelled);
		completedAt = now();
		return buildSnapshot();
	}

	// -----------------------------------------------------------------------
	// PHASE 7: DELIVERED
	// -----------------------------------------------------------------------
	completedAt = now();
	transition(ORDER_STATUS.Delivered);
	addTimeline('Order delivered', 'durable-recovery');
	await writeAuditLog({ orderId: currentInput.orderId, event: 'delivered', timestamp: now() });
	await emitMetrics({ orderId: currentInput.orderId, phase: 'delivered' });
	await condition(allHandlersFinished);
	return buildSnapshot();

	// -----------------------------------------------------------------------
	// Delivery phase inner function (also used when resuming from continueAsNew)
	// -----------------------------------------------------------------------
	async function runDeliveryPhase(): Promise<void> {
		if (!courier) {
			throw new Error('runDeliveryPhase called without courier');
		}

		const childWorkflowId = `delivery-${currentInput.orderId}`;
		const deliveryInput: DeliveryInput = {
			orderId: currentInput.orderId,
			courierId: courier.courierId,
			courierName: courier.name,
			deliveryAddress: currentInput.deliveryAddress,
			heartbeatIntervalMs: 500 // fast heartbeat for demo
		};

		// Start the child INSIDE the cancellable scope so that scope.cancel() from
		// the cancelOrderSignal handler propagates to the child workflow automatically.
		deliveryCancellationScope = new CancellationScope({ cancellable: true });
		let childDeliveryResult: DeliveryResult | null = null;
		try {
			await deliveryCancellationScope.run(async () => {
				const childHandle = await startChild<typeof deliveryWorkflow>(deliveryWorkflow, {
					workflowId: childWorkflowId,
					args: [deliveryInput],
					taskQueue: TASK_QUEUE
				});
				addTimeline(`Delivery child started: ${childWorkflowId}`, 'child-workflow');
				childDeliveryResult = await childHandle.result();
			});
			addTimeline('Delivery completed by child workflow', 'child-workflow');
			if (childDeliveryResult !== null && !childDeliveryResult.deliveredOnTime) {
				addTimeline('Delivery SLA breached — escalation triggered', 'timers-durable-sleep');
				log.warn('orderFoodWorkflow: delivery SLA breached', {
					orderId: currentInput.orderId
				});
			}
		} catch (err) {
			if (isCancellation(err)) {
				// Scope cancellation already propagated to the child; run compensations.
				addTimeline(`Delivery cancelled: ${cancelReason}`, 'heartbeats-cancellation');
				await runCompensations();
				transition(ORDER_STATUS.Cancelled);
				completedAt = now();
				throw err; // rethrow — outer catch returns the snapshot
			}
			throw err;
		} finally {
			deliveryCancellationScope = null;
		}

		// continueAsNew gate — if many location updates have accumulated
		if (locationUpdateCount >= 100) {
			continueAsNewPending = true;
			addTimeline('continueAsNew triggered after 100 location updates', 'continue-as-new');
			await condition(allHandlersFinished);
			await continueAsNew<typeof orderFoodWorkflow>(currentInput, buildSnapshot());
		}
	}
}

// ---------------------------------------------------------------------------
// deliveryWorkflow  (child workflow)
// ---------------------------------------------------------------------------

/**
 * Manages the courier lifecycle for a single delivery.
 *
 * Demonstrates: heartbeating activity inside a CancellationScope,
 * parent cancellation propagation, child workflow independence.
 */
export async function deliveryWorkflow(input: DeliveryInput): Promise<DeliveryResult> {
	let deliveryDone = false;
	let deliveredOnTime = false;

	setHandler(deliveryCompletedSignal, () => {
		deliveryDone = true;
		deliveredOnTime = true;
	});

	log.info('deliveryWorkflow: starting', {
		orderId: input.orderId,
		courierId: input.courierId
	});

	// Start courier tracking in a cancellable scope
	const trackingScope = new CancellationScope({ cancellable: true });
	const trackingPromise = trackingScope.run(async () => {
		await trackCourier({
			courierId: input.courierId,
			orderId: input.orderId,
			heartbeatIntervalMs: input.heartbeatIntervalMs ?? 5_000,
			maxTicks: input.maxTrackerTicks
		});
	});

	try {
		// Wait for delivery completion or the configurable SLA deadline.
		// condition() returns false on timeout — deliveredOnTime stays false → SLA breached.
		await condition(() => deliveryDone, input.slaTimeout ?? '2h');
	} catch (err) {
		if (isCancellation(err)) {
			// Parent cancelled this child — tracking will be cancelled automatically
			// (root CancellationScope propagates to trackingScope)
			log.info('deliveryWorkflow: cancelled by parent');
			try {
				await trackingPromise;
			} catch (trackErr) {
				if (!isCancellation(trackErr)) {
					throw trackErr;
				}
			}
			throw err; // Propagate cancellation
		}
		throw err;
	}

	// Delivery done — cancel tracker
	trackingScope.cancel();
	try {
		await trackingPromise;
	} catch (trackErr) {
		if (!isCancellation(trackErr)) {
			throw trackErr;
		}
	}

	if (!deliveredOnTime) {
		log.warn('deliveryWorkflow: SLA breached — delivery exceeded deadline', {
			orderId: input.orderId,
			courierId: input.courierId
		});
	}

	log.info('deliveryWorkflow: completed', {
		orderId: input.orderId,
		courierId: input.courierId,
		deliveredOnTime
	});

	return { deliveredOnTime, courierId: input.courierId };
}

// ---------------------------------------------------------------------------
// subscriptionWorkflow  (continueAsNew loop)
// ---------------------------------------------------------------------------

/**
 * Manages a periodic food subscription.
 *
 * Each cycle places one order then sleeps before the next reorder.
 * Calls `continueAsNew` at the end of every cycle to bound event history.
 *
 * Demonstrates: `continueAsNew` carrying state across runs.
 */
export async function subscriptionWorkflow(input: SubscriptionInput): Promise<void> {
	const info = workflowInfo();
	log.info('subscriptionWorkflow: cycle start', {
		cycleCount: input.cycleCount,
		workflowId: info.workflowId
	});

	// Check termination condition
	if (input.maxCycles && input.maxCycles > 0 && input.cycleCount >= input.maxCycles) {
		log.info('subscriptionWorkflow: max cycles reached', { cycleCount: input.cycleCount });
		return;
	}

	// Place an order for this cycle
	const cycleOrderId = `${info.workflowId}-cycle-${input.cycleCount}`;
	const orderInput: OrderInput = {
		...input.baseOrder,
		orderId: cycleOrderId
	};

	try {
		await executeChild(orderFoodWorkflow, {
			workflowId: cycleOrderId,
			args: [orderInput],
			taskQueue: TASK_QUEUE
		});
	} catch (err) {
		// Log but continue subscription even if one order fails
		log.error('subscriptionWorkflow: order cycle failed', {
			cycleCount: input.cycleCount,
			error: err instanceof Error ? err.message : String(err)
		});
	}

	// Wait before next reorder (1 week in production; use short duration in tests)
	await sleep('7d');

	// ContinueAsNew — carry cycle count and last order ID into the new run
	await continueAsNew<typeof subscriptionWorkflow>({
		...input,
		cycleCount: input.cycleCount + 1,
		lastOrderId: cycleOrderId
	});
}

// ---------------------------------------------------------------------------
// timeSkipSanity — used only by the test suite to verify time-skipping works
// ---------------------------------------------------------------------------

/**
 * Minimal workflow that does nothing but sleep for 1 hour.
 * The test suite uses this to confirm the time-skipping test server is
 * advancing time correctly before relying on timer-based tests.
 */
export async function timeSkipSanity(): Promise<string> {
	await sleep('1h');
	return 'ok';
}
