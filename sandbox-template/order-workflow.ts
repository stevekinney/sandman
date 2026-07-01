/**
 * order-workflow.ts — the main food-ordering workflow.
 *
 * A Temporal workflow is just a function — but every await in it is durable.
 * Temporal records each step (activity result, timer, signal) in an event
 * history; if the worker running this code dies, a new worker *replays* that
 * history and the function resumes exactly where it left off, local variables
 * and all. That one idea explains everything in this file.
 *
 * The order moves through: validate → charge → wait for the restaurant →
 * prepare → assign a courier → hand delivery to a child workflow → done.
 * Signals nudge it forward, queries read it, updates change it, and a saga
 * compensates (refunds) if anything goes wrong after money moved.
 *
 * Look for "Try:" comments — each marks a small edit you can make (save
 * hot-restarts the worker) to see visibly different behavior.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	ChildWorkflowCancellationType,
	ParentClosePolicy,
	allHandlersFinished,
	condition,
	continueAsNew,
	getExternalWorkflowHandle,
	isCancellation,
	patched,
	setHandler,
	startChild,
	upsertSearchAttributes,
	workflowInfo
} from '@temporalio/workflow';
import {
	applyPromoCodeUpdate,
	assignCourier,
	calculatePricing,
	chargePayment,
	customerTierSearchAttributeKey,
	dispatchCourier,
	emitMetrics,
	getStatusQuery,
	getTimelineQuery,
	notifyRestaurant,
	orderStatusSearchAttributeKey,
	refundPayment,
	releaseCourier,
	restaurantIdSearchAttributeKey,
	updateDeliveryAddressUpdate,
	validateOrder,
	writeAuditLog
} from './definitions.ts';
import {
	addTipSignal,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	foodReadySignal,
	restaurantAcceptedSignal,
	restaurantRejectedSignal
} from './signals.ts';
import { ORDER_STATUS, PROMO_CODES, TASK_QUEUE, WORKFLOW_EVENT_TYPE } from './shared.ts';
import { deliveryWorkflow } from './delivery-workflow.ts';

/** One forward step of the saga, paired with the action that undoes it. */
type CompensationStep = {
	action: string;
	run: () => Promise<void>;
};

/**
 * Workflow-safe "now": Temporal patches Date.now() so it is deterministic on
 * replay (every worker that replays this history sees the same timestamps).
 */
function now(): string {
	return new Date(Date.now()).toISOString();
}

/** Look up a promo code without letting unknown keys reach the discount math. */
function getPromo(code: string): (typeof PROMO_CODES)[PromoCodeKey] | undefined {
	if (Object.prototype.hasOwnProperty.call(PROMO_CODES, code)) {
		return PROMO_CODES[code as PromoCodeKey];
	}
	return undefined;
}

/** Dig the attempt count out of a failed chargePayment's error details. */
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

/**
 * The food-ordering workflow. `input` describes the order; `seed` is only
 * passed when a previous run hands its state forward via continueAsNew.
 */
export async function orderFoodWorkflow(
	input: OrderInput,
	seed?: OrderSnapshot
): Promise<OrderSnapshot> {
	// ── Durable state ─────────────────────────────────────────────────────
	// Plain local variables — no database. Temporal's replay makes them
	// durable: after a crash, re-running the recorded history rebuilds every
	// one of these to exactly the value it had.
	let status: OrderStatus = seed?.status ?? ORDER_STATUS.Created;
	let currentInput = seed?.input ?? input;
	let subtotalCents = seed?.subtotalCents ?? 0;
	// Try: change the delivery fee and place a new order — "Get status" shows
	// the new total in the snapshot.
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
	const activityOperations: Record<string, ActivityOperationMetadata> =
		seed?.activityOperations ?? {};
	const compensationStack: CompensationStep[] = [];
	const timeline: TimelineEntry[] =
		seed?.timelineDescriptions.map((description, index) => ({
			index,
			timestamp: updatedAt,
			description,
			status
		})) ?? [];

	// Signal handlers below flip these flags; the workflow body awaits them.
	let cancelReason = '';
	let restaurantAccepted = false;
	let restaurantRejectedReason = '';
	let foodReady = false;
	// Try: pass historyCompactionThreshold: 5 when starting an order, then send
	// courier location updates — the run compacts itself via continueAsNew.
	const historyCompactionThreshold = currentInput.historyCompactionThreshold ?? 100;

	// ── Small helpers over that state ─────────────────────────────────────

	/** Move to a new lifecycle status and record why on the teaching timeline. */
	function transition(
		nextStatus: OrderStatus,
		description: string,
		featureId?: FeatureId,
		eventType?: WorkflowEventType
	): void {
		status = nextStatus;
		upsertBusinessSearchAttributes();
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

	/** Record a timeline entry without changing the lifecycle status. */
	function addTimeline(
		description: string,
		featureId?: FeatureId,
		eventType?: WorkflowEventType
	): void {
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

	/** The business fields we also publish as Temporal Search Attributes. */
	function businessSnapshot(): BusinessSnapshot {
		return {
			OrderStatus: status,
			CustomerTier: currentInput.customerTier,
			RestaurantId: currentInput.restaurantId
		};
	}

	/** Publish status/tier/restaurant to the cluster's Visibility index. */
	function upsertBusinessSearchAttributes(): void {
		if (currentInput.visibilitySearchAttributesEnabled !== true) return;
		upsertSearchAttributes([
			{ key: orderStatusSearchAttributeKey, value: status },
			{ key: customerTierSearchAttributeKey, value: currentInput.customerTier },
			{ key: restaurantIdSearchAttributeKey, value: currentInput.restaurantId }
		]);
	}

	/**
	 * Idempotency metadata for a side-effecting activity: if a retry re-runs
	 * the activity, the downstream system can deduplicate by this key.
	 */
	function operation(operationId: string): ActivityOperationMetadata {
		return {
			operationId,
			idempotencyKey: `${currentInput.orderId}:${operationId}`,
			workflowId: workflowInfo().workflowId,
			orderId: currentInput.orderId
		};
	}

	function rememberOperation(name: string, metadata: ActivityOperationMetadata): void {
		activityOperations[name] = metadata;
	}

	/**
	 * Saga bookkeeping: every forward step that moves money or claims a
	 * resource registers its exact inverse here, so rollback is always the
	 * mirror image of what actually happened.
	 */
	function registerCompensation(action: string, run: () => Promise<void>): void {
		compensationStack.push({ action, run });
		addTimeline(`Registered compensation: ${action}`, 'saga-compensation');
	}

	/** The full queryable state — what the getStatus query returns. */
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
			activityOperations,
			courier,
			locationUpdateCount,
			deliveryDeadline,
			startedAt,
			updatedAt,
			completedAt,
			appliedPromoCode,
			continueAsNewPending,
			businessSnapshot: businessSnapshot(),
			timelineDescriptions: timeline.map((entry) => entry.description)
		};
	}

	/**
	 * Unwind the saga: run every registered compensation in reverse order
	 * (refund before releasing the courier, etc.), then finish the workflow
	 * in the given terminal status.
	 */
	async function refundAndFinish(
		nextStatus: OrderStatus,
		description: string
	): Promise<OrderSnapshot> {
		for (let index = compensationStack.length - 1; index >= 0; index--) {
			const step = compensationStack[index];
			try {
				await step.run();
				compensations.push({ action: step.action, timestamp: now(), ok: true });
				addTimeline(`Executed compensation: ${step.action}`, 'saga-compensation');
			} catch (err) {
				const record: CompensationRecord = {
					action: step.action,
					timestamp: now(),
					ok: false,
					errorMessage: err instanceof Error ? err.message : String(err)
				};
				compensations.push(record);
				addTimeline(`Failed compensation: ${step.action}`, 'saga-compensation');
				throw err;
			}
		}
		completedAt = now();
		transition(nextStatus, description, 'saga-compensation');
		return snapshot();
	}

	/** Cancellation propagates: a cancelled order also cancels its delivery child. */
	async function cancelDeliveryChild(): Promise<void> {
		if (deliveryWorkflowId === undefined || !deliveryChildStarted) return;
		await getExternalWorkflowHandle(deliveryWorkflowId).cancel();
	}

	// ── Signal handlers ───────────────────────────────────────────────────
	// Signals are async messages INTO a running workflow. A handler just
	// mutates local state; code parked on `condition(...)` wakes up when the
	// flag it is watching flips. Nothing polls.
	setHandler(cancelOrderSignal, async (payload) => {
		cancelReason = payload.reason;
		addTimeline(`Cancel requested: ${payload.reason}`, 'signals');
		await cancelDeliveryChild();
	});
	setHandler(restaurantAcceptedSignal, (payload) => {
		restaurantAccepted = true;
		addTimeline(
			`Restaurant accepted, prep ${payload.estimatedPrepMinutes}m`,
			'signals',
			WORKFLOW_EVENT_TYPE.WorkflowExecutionSignaled
		);
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

	// ── Query handlers ────────────────────────────────────────────────────
	// Read-only: answering a query never advances the workflow or writes
	// history. It simply returns current in-memory state.
	setHandler(getStatusQuery, snapshot);
	setHandler(getTimelineQuery, () => [...timeline]);

	// ── Update handlers ───────────────────────────────────────────────────
	// Each update has a validator that runs synchronously FIRST. Throw there
	// and the update is rejected with nothing written to history — the caller
	// gets the rejection immediately.
	setHandler(
		updateDeliveryAddressUpdate,
		(payload) => {
			currentInput = { ...currentInput, deliveryAddress: payload.newAddress };
			addTimeline(
				'Delivery address updated',
				'updates-validators',
				WORKFLOW_EVENT_TYPE.WorkflowExecutionUpdateAccepted
			);
			return { updated: true, effectiveAddress: currentInput.deliveryAddress };
		},
		{
			validator: () => {
				// Try: also reject while the order is Preparing — add
				// `|| status === ORDER_STATUS.Preparing` and watch the update
				// bounce synchronously.
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

	// ── ContinueAsNew resume path ─────────────────────────────────────────
	// If a previous run compacted its history mid-delivery, this run receives
	// its state as `seed` and finishes the order from where it stopped.
	if (seed?.continueAsNewPending && seed.status === ORDER_STATUS.InDelivery) {
		continueAsNewPending = false;
		completedAt = now();
		transition(
			ORDER_STATUS.Delivered,
			'Order delivered after ContinueAsNew history compaction',
			'continue-as-new',
			WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
		);
		const auditOperation = operation('write-audit-log-delivered');
		rememberOperation('writeAuditLog', auditOperation);
		await writeAuditLog({
			operation: auditOperation,
			orderId: currentInput.orderId,
			event: 'delivered',
			timestamp: now()
		});
		await condition(allHandlersFinished);
		return snapshot();
	}

	// `patched` lets already-running workflows replay against old code while
	// new runs take the new path — Temporal's answer to versioning live code.
	if (patched('sandman-idempotent-activity-operations')) {
		addTimeline('Replay-safe patch marker: idempotent activity operations', 'replay-safety');
	}

	// ── 1. Validate and price ─────────────────────────────────────────────
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
	const metricsOperation = operation('emit-metrics-validated');
	rememberOperation('emitMetrics', metricsOperation);
	await emitMetrics({
		operation: metricsOperation,
		orderId: currentInput.orderId,
		phase: 'validated'
	});

	// ── 2. Charge the customer ────────────────────────────────────────────
	// chargePayment retries automatically on transient failures (the policy
	// lives in definitions.ts). Only a non-retryable failure — a genuinely
	// declined card — lands in this catch block.
	try {
		const chargeOperation = operation('charge-payment');
		const charge = await chargePayment(chargeOperation, currentInput.paymentMethod, totalCents);
		attemptCounts['chargePayment'] = charge.attempts;
		rememberOperation('chargePayment', charge.operation);
		// Money moved: register the exact inverse in case we must roll back.
		registerCompensation('refund-payment', async () => {
			const refundOperation = operation('refund-payment');
			rememberOperation('refundPayment', refundOperation);
			await refundPayment(refundOperation, totalCents);
		});
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

	// ── 3. Wait for the restaurant (durable timer + signal) ──────────────
	transition(
		ORDER_STATUS.AwaitingRestaurant,
		'Waiting for restaurant',
		'timers-durable-sleep',
		WORKFLOW_EVENT_TYPE.TimerStarted
	);
	const notifyOperation = operation('notify-restaurant');
	const notification = await notifyRestaurant(
		notifyOperation,
		currentInput.restaurantId,
		currentInput.items
	);
	rememberOperation('notifyRestaurant', notification.operation);
	// The workflow parks here. `condition` resumes when a signal handler
	// flips one of these flags — or when the deadline timer fires. The timer
	// lives in the Temporal server: kill the worker and it still counts down.
	// Try: shrink the `?? 10` minute fallback to `?? 1`, place an order, and
	// let the deadline pass — the saga refunds the payment automatically.
	const accepted = await condition(
		() => restaurantAccepted || Boolean(restaurantRejectedReason) || Boolean(cancelReason),
		`${currentInput.restaurantAcceptTimeoutMinutes ?? 10}m`
	);
	if (!accepted) return refundAndFinish(ORDER_STATUS.Refunded, 'Restaurant did not respond');
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);
	if (restaurantRejectedReason) {
		return refundAndFinish(ORDER_STATUS.Cancelled, `Rejected: ${restaurantRejectedReason}`);
	}

	// ── 4. Prepare the food ───────────────────────────────────────────────
	transition(ORDER_STATUS.Preparing, 'Restaurant is preparing the order', 'signals');
	await condition(() => foodReady || Boolean(cancelReason));
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);

	// ── 5. Assign and dispatch a courier ─────────────────────────────────
	transition(ORDER_STATUS.AwaitingCourier, 'Assigning courier', 'child-workflow');
	const assignCourierOperation = operation('assign-courier');
	const assignedCourier = await assignCourier(assignCourierOperation, currentInput.deliveryAddress);
	rememberOperation('assignCourier', assignedCourier.operation);
	courier = {
		courierId: assignedCourier.courierId,
		name: assignedCourier.name,
		location: assignedCourier.location,
		etaMinutes: assignedCourier.etaMinutes
	};
	registerCompensation('release-courier', async () => {
		if (!courier) return;
		const releaseOperation = operation('release-courier');
		rememberOperation('releaseCourier', releaseOperation);
		await releaseCourier(releaseOperation, courier.courierId);
	});
	const dispatchOperation = operation('dispatch-courier');
	const dispatch = await dispatchCourier(
		dispatchOperation,
		courier.courierId,
		currentInput.deliveryAddress
	);
	rememberOperation('dispatchCourier', dispatch.operation);
	if (cancelReason) return refundAndFinish(ORDER_STATUS.Cancelled, `Cancelled: ${cancelReason}`);

	// ── 6. Hand delivery to a child workflow ─────────────────────────────
	deliveryDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
	transition(ORDER_STATUS.InDelivery, 'Starting delivery child workflow', 'child-workflow');

	try {
		deliveryWorkflowId = `delivery-${currentInput.orderId}`;
		// The child is a full workflow: its own history, its own page in the
		// Temporal UI, independently signalable — while this parent awaits it.
		// Try: change heartbeatIntervalMs to 5_000 and watch the courier
		// heartbeats slow down in the worker logs.
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

	// ── 7. Compact history if this run grew too long ─────────────────────
	if (locationUpdateCount >= historyCompactionThreshold) {
		continueAsNewPending = true;
		const suggested = workflowInfo().continueAsNewSuggested;
		addTimeline(
			`ContinueAsNew triggered by demo history threshold; workflowInfo().continueAsNewSuggested was ${suggested ? 'true' : 'false'}`,
			'continue-as-new'
		);
		transition(
			ORDER_STATUS.InDelivery,
			`History compaction threshold reached after ${locationUpdateCount} courier location updates`,
			'continue-as-new',
			WORKFLOW_EVENT_TYPE.WorkflowExecutionContinuedAsNew
		);
		await condition(allHandlersFinished);
		await continueAsNew<typeof orderFoodWorkflow>(currentInput, snapshot());
	}

	// ── 8. Delivered ──────────────────────────────────────────────────────
	completedAt = now();
	transition(
		ORDER_STATUS.Delivered,
		'Order delivered',
		'durable-recovery',
		WORKFLOW_EVENT_TYPE.WorkflowExecutionCompleted
	);
	const deliveredAuditOperation = operation('write-audit-log-delivered');
	rememberOperation('writeAuditLog', deliveredAuditOperation);
	await writeAuditLog({
		operation: deliveredAuditOperation,
		orderId: currentInput.orderId,
		event: 'delivered',
		timestamp: now()
	});
	// Let any in-flight signal/update handlers finish before returning.
	await condition(allHandlersFinished);
	return snapshot();
}
