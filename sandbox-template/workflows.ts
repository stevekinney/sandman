/**
 * A compact Temporal demo workflow.
 *
 * The workflow code is intentionally small enough to read in the browser:
 * activities do the outside-world work, signals move the order forward, queries
 * expose state, updates validate synchronous changes, and a child workflow owns
 * delivery.
 */

import {
	ActivityCancellationType,
	ActivityFailure,
	ApplicationFailure,
	ChildWorkflowCancellationType,
	CancellationScope,
	ParentClosePolicy,
	allHandlersFinished,
	condition,
	continueAsNew,
	defineQuery,
	defineUpdate,
	executeChild,
	getExternalWorkflowHandle,
	isCancellation,
	proxyActivities,
	proxyLocalActivities,
	setHandler,
	sleep,
	startChild,
	workflowInfo
} from '@temporalio/workflow';
import type * as acts from './activities.ts';
import {
	addTipSignal,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	deliveryCompletedSignal,
	foodReadySignal,
	restaurantAcceptedSignal,
	restaurantRejectedSignal
} from './signals.ts';
import { ORDER_STATUS, PROMO_CODES, TASK_QUEUE, WORKFLOW_EVENT_TYPE } from './shared.ts';

export {
	addTipSignal,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	deliveryCompletedSignal,
	foodReadySignal,
	restaurantAcceptedSignal,
	restaurantRejectedSignal
} from './signals.ts';

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
		maximumAttempts: 5,
		nonRetryableErrorTypes: ['PAYMENT_DECLINED', 'INVALID_ORDER', 'INVALID_ADDRESS']
	}
});

const { trackCourier } = proxyActivities<Pick<typeof acts, 'trackCourier'>>({
	startToCloseTimeout: '2h',
	heartbeatTimeout: '30s',
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 1 }
});

const { validateOrder, calculatePricing, writeAuditLog, emitMetrics } = proxyLocalActivities<
	typeof acts
>({
	startToCloseTimeout: '10s',
	retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['INVALID_ORDER', 'INVALID_ADDRESS'] }
});

export const getStatusQuery = defineQuery<OrderSnapshot>('getStatus');
export const getTimelineQuery = defineQuery<TimelineEntry[]>('getTimeline');

export const updateDeliveryAddressUpdate = defineUpdate<
	UpdateDeliveryAddressResult,
	[UpdateDeliveryAddressInput]
>('updateDeliveryAddress');
export const applyPromoCodeUpdate = defineUpdate<ApplyPromoCodeResult, [ApplyPromoCodeInput]>(
	'applyPromoCode'
);

type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
type PromoCode = keyof typeof PROMO_CODES;

function now(): string {
	return new Date(Date.now()).toISOString();
}

function getPromo(code: string): (typeof PROMO_CODES)[PromoCode] | undefined {
	if (Object.prototype.hasOwnProperty.call(PROMO_CODES, code)) {
		return PROMO_CODES[code as PromoCode];
	}
	return undefined;
}

function getChargePaymentAttemptCount(error: unknown): number | undefined {
	if (!(error instanceof ActivityFailure)) return undefined;
	if (!(error.cause instanceof ApplicationFailure)) return undefined;
	const [detail] = error.cause.details ?? [];
	if (!isAttemptCountDetail(detail)) return undefined;
	return detail.attempts;
}

function isAttemptCountDetail(value: unknown): value is { attempts: number } {
	if (typeof value !== 'object' || value === null || !('attempts' in value)) return false;
	return typeof value.attempts === 'number';
}

export async function orderFoodWorkflow(
	input: OrderInput,
	seed?: OrderSnapshot
): Promise<OrderSnapshot> {
	let status: OrderStatus = seed?.status ?? ORDER_STATUS.Created;
	let currentInput = seed?.input ?? input;
	let subtotalCents = seed?.subtotalCents ?? 0;
	let deliveryFeeCents = seed?.deliveryFeeCents ?? 299;
	let tipCents = seed?.tipCents ?? 0;
	let promoDiscountCents = seed?.promoDiscountCents ?? 0;
	let totalCents = seed?.totalCents ?? 0;
	let courier: CourierInfo | undefined = seed?.courier;
	let locationUpdateCount = seed?.locationUpdateCount ?? 0;
	let appliedPromoCode = seed?.appliedPromoCode;
	let deliveryDeadline: string | undefined = seed?.deliveryDeadline;
	let completedAt: string | undefined = seed?.completedAt;
	let continueAsNewPending = false;
	let deliveryWorkflowId: string | undefined;
	let deliveryChildStarted = false;

	const startedAt = seed?.startedAt ?? now();
	let updatedAt = seed?.updatedAt ?? startedAt;
	const attemptCounts: Record<string, number> = seed?.attemptCounts ?? {};
	const compensations = seed?.compensations ?? [];
	const timeline: TimelineEntry[] = [];

	let cancelReason = '';
	let restaurantAccepted = false;
	let restaurantRejectedReason = '';
	let foodReady = false;
	const historyCompactionThreshold = currentInput.historyCompactionThreshold ?? 100;

	function transition(
		nextStatus: OrderStatus,
		description: string,
		featureId?: FeatureId,
		eventType?: WorkflowEventType
	): void {
		status = nextStatus;
		timeline.push({
			index: timeline.length,
			timestamp: now(),
			description,
			status,
			featureId,
			eventType
		});
		updatedAt = now();
	}

	function snapshot(): OrderSnapshot {
		return {
			status,
			input: currentInput,
			subtotalCents,
			deliveryFeeCents,
			tipCents,
			promoDiscountCents,
			totalCents,
			attemptCounts,
			compensations,
			courier,
			locationUpdateCount,
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

	async function refundAndFinish(
		nextStatus: OrderStatus,
		description: string
	): Promise<OrderSnapshot> {
		if (courier) {
			await releaseCourier(currentInput.orderId, courier.courierId);
			compensations.push({ action: 'release-courier', timestamp: now(), ok: true });
		}
		await refundPayment(currentInput.orderId, totalCents);
		compensations.push({ action: 'refund-payment', timestamp: now(), ok: true });
		completedAt = now();
		transition(nextStatus, description, 'saga-compensation');
		return snapshot();
	}

	async function cancelDeliveryChild(): Promise<void> {
		if (deliveryWorkflowId === undefined || !deliveryChildStarted) return;
		await getExternalWorkflowHandle(deliveryWorkflowId).cancel();
	}

	setHandler(cancelOrderSignal, async (payload) => {
		cancelReason = payload.reason;
		timeline.push({
			index: timeline.length,
			timestamp: now(),
			description: `Cancel requested: ${payload.reason}`,
			status,
			featureId: 'signals'
		});
		await cancelDeliveryChild();
	});
	setHandler(restaurantAcceptedSignal, (payload) => {
		restaurantAccepted = true;
		timeline.push({
			index: timeline.length,
			timestamp: now(),
			description: `Restaurant accepted, prep ${payload.estimatedPrepMinutes}m`,
			status,
			featureId: 'signals',
			eventType: WORKFLOW_EVENT_TYPE.WorkflowExecutionSignaled
		});
	});
	setHandler(restaurantRejectedSignal, (payload) => {
		restaurantRejectedReason = payload.reason;
	});
	setHandler(foodReadySignal, () => {
		foodReady = true;
	});
	setHandler(courierLocationUpdateSignal, (location) => {
		courier = courier ? { ...courier, location } : courier;
		locationUpdateCount++;
		if (locationUpdateCount >= historyCompactionThreshold) {
			continueAsNewPending = true;
		}
	});
	setHandler(addTipSignal, (payload) => {
		tipCents += payload.amountCents;
		totalCents += payload.amountCents;
	});

	setHandler(getStatusQuery, snapshot);
	setHandler(getTimelineQuery, () => [...timeline]);

	setHandler(
		updateDeliveryAddressUpdate,
		(payload) => {
			currentInput = { ...currentInput, deliveryAddress: payload.newAddress };
			timeline.push({
				index: timeline.length,
				timestamp: now(),
				description: 'Delivery address updated',
				status,
				featureId: 'updates-validators',
				eventType: WORKFLOW_EVENT_TYPE.WorkflowExecutionUpdateAccepted
			});
			return { updated: true, effectiveAddress: currentInput.deliveryAddress };
		},
		{
			validator: () => {
				if (status === ORDER_STATUS.InDelivery || status === ORDER_STATUS.Delivered) {
					throw ApplicationFailure.nonRetryable('order-already-in-delivery', 'UPDATE_REJECTED');
				}
			}
		}
	);

	setHandler(
		applyPromoCodeUpdate,
		(payload) => {
			const promo = getPromo(payload.code.toUpperCase());
			if (!promo) throw ApplicationFailure.nonRetryable('invalid-code', 'UPDATE_REJECTED');
			const discountCents =
				'discountPercent' in promo
					? Math.floor((subtotalCents * promo.discountPercent) / 100)
					: Math.min(promo.discountCents, subtotalCents);
			appliedPromoCode = payload.code;
			promoDiscountCents = discountCents;
			totalCents = subtotalCents + deliveryFeeCents + tipCents - promoDiscountCents;
			return { discountCents, newTotalCents: totalCents, description: promo.description };
		},
		{
			validator: (payload) => {
				if (appliedPromoCode) {
					throw ApplicationFailure.nonRetryable('code-already-used', 'UPDATE_REJECTED');
				}
				if (!getPromo(payload.code.toUpperCase())) {
					throw ApplicationFailure.nonRetryable('invalid-code', 'UPDATE_REJECTED');
				}
			}
		}
	);

	if (seed?.continueAsNewPending && seed.status === ORDER_STATUS.InDelivery) {
		continueAsNewPending = false;
		completedAt = now();
		transition(
			ORDER_STATUS.Delivered,
			'Order delivered after ContinueAsNew history compaction',
			'continue-as-new',
			WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
		);
		await writeAuditLog({ orderId: currentInput.orderId, event: 'delivered', timestamp: now() });
		await condition(allHandlersFinished);
		return snapshot();
	}

	transition(
		ORDER_STATUS.Created,
		'Workflow execution started',
		'activities-retry',
		WORKFLOW_EVENT_TYPE.WorkflowExecutionStarted
	);
	transition(ORDER_STATUS.Validating, 'Validating order', 'local-activities');
	await validateOrder(currentInput);
	const pricing = await calculatePricing(currentInput.items, currentInput.promoCode);
	subtotalCents = pricing.subtotalCents;
	deliveryFeeCents = pricing.deliveryFeeCents;
	promoDiscountCents = pricing.promoDiscountCents;
	totalCents = pricing.totalCents;
	await emitMetrics({ orderId: currentInput.orderId, phase: 'validated' });

	try {
		const charge = await chargePayment(
			currentInput.orderId,
			currentInput.paymentMethod,
			totalCents
		);
		attemptCounts['chargePayment'] = charge.attempts;
	} catch (err) {
		const attempts = getChargePaymentAttemptCount(err);
		if (attempts !== undefined) attemptCounts['chargePayment'] = attempts;
		completedAt = now();
		transition(ORDER_STATUS.Cancelled, 'Payment declined', 'non-retryable-failure');
		return snapshot();
	}

	transition(
		ORDER_STATUS.Validating,
		'Payment charged',
		'activities-retry',
		WORKFLOW_EVENT_TYPE.ActivityTaskCompleted
	);
	transition(
		ORDER_STATUS.AwaitingRestaurant,
		'Waiting for restaurant',
		'timers-durable-sleep',
		WORKFLOW_EVENT_TYPE.TimerStarted
	);
	await notifyRestaurant(currentInput.orderId, currentInput.restaurantId, currentInput.items);
	const accepted = await condition(
		() => restaurantAccepted || Boolean(restaurantRejectedReason) || Boolean(cancelReason),
		`${currentInput.restaurantAcceptTimeoutMinutes ?? 10}m`
	);
	if (!accepted) return refundAndFinish(ORDER_STATUS.Refunded, 'Restaurant did not respond');
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);
	if (restaurantRejectedReason) {
		return refundAndFinish(ORDER_STATUS.Cancelled, `Rejected: ${restaurantRejectedReason}`);
	}

	transition(ORDER_STATUS.Preparing, 'Restaurant is preparing the order', 'signals');
	await condition(() => foodReady || Boolean(cancelReason));
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);

	transition(ORDER_STATUS.AwaitingCourier, 'Assigning courier', 'child-workflow');
	courier = await assignCourier(currentInput.orderId, currentInput.deliveryAddress);
	await dispatchCourier(currentInput.orderId, courier.courierId, currentInput.deliveryAddress);
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);

	deliveryDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
	transition(ORDER_STATUS.InDelivery, 'Starting delivery child workflow', 'child-workflow');

	try {
		deliveryWorkflowId = `delivery-${currentInput.orderId}`;
		const child = await startChild<typeof deliveryWorkflow>(deliveryWorkflow, {
			workflowId: deliveryWorkflowId,
			args: [
				{
					orderId: currentInput.orderId,
					courierId: courier?.courierId ?? '',
					courierName: courier?.name ?? '',
					deliveryAddress: currentInput.deliveryAddress,
					heartbeatIntervalMs: 500
				}
			],
			taskQueue: TASK_QUEUE,
			cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
			parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL
		});
		deliveryChildStarted = true;
		transition(
			ORDER_STATUS.InDelivery,
			'Delivery child workflow started',
			'child-workflow',
			WORKFLOW_EVENT_TYPE.ChildWorkflowExecutionStarted
		);
		if (cancelReason) await cancelDeliveryChild();
		await child.result();
	} catch (err) {
		if (isCancellation(err)) return refundAndFinish(ORDER_STATUS.Cancelled, 'Delivery cancelled');
		throw err;
	} finally {
		deliveryWorkflowId = undefined;
		deliveryChildStarted = false;
	}

	if (locationUpdateCount >= historyCompactionThreshold) {
		continueAsNewPending = true;
		transition(
			ORDER_STATUS.InDelivery,
			`History compaction threshold reached after ${locationUpdateCount} courier location updates`,
			'continue-as-new',
			WORKFLOW_EVENT_TYPE.WorkflowExecutionContinuedAsNew
		);
		await condition(allHandlersFinished);
		await continueAsNew<typeof orderFoodWorkflow>(currentInput, snapshot());
	}

	completedAt = now();
	transition(
		ORDER_STATUS.Delivered,
		'Order delivered',
		'durable-recovery',
		WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
	);
	await writeAuditLog({ orderId: currentInput.orderId, event: 'delivered', timestamp: now() });
	await condition(allHandlersFinished);
	return snapshot();
}

export async function deliveryWorkflow(input: DeliveryInput): Promise<DeliveryResult> {
	let deliveredOnTime = false;
	setHandler(deliveryCompletedSignal, () => {
		deliveredOnTime = true;
	});

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
		await condition(() => deliveredOnTime, input.slaTimeout ?? '2h');
	} finally {
		trackingScope.cancel();
		try {
			await tracking;
		} catch (err) {
			if (!isCancellation(err)) trackingError = err;
		}
	}
	if (trackingError) throw trackingError;
	return { deliveredOnTime, courierId: input.courierId };
}

export async function subscriptionWorkflow(input: SubscriptionInput): Promise<void> {
	const info = workflowInfo();
	if (input.maxCycles && input.cycleCount >= input.maxCycles) return;
	const orderId = `${info.workflowId}-cycle-${input.cycleCount}`;
	await executeChild(orderFoodWorkflow, {
		workflowId: orderId,
		args: [{ ...input.baseOrder, orderId }],
		taskQueue: TASK_QUEUE
	});
	await sleep('7d');
	await continueAsNew<typeof subscriptionWorkflow>({
		...input,
		cycleCount: input.cycleCount + 1,
		lastOrderId: orderId
	});
}

export async function timeSkipSanity(): Promise<string> {
	await sleep('1h');
	return 'ok';
}
