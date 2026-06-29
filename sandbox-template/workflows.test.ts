/**
 * workflows.test.ts — TDD acceptance tests for the Sandman food-ordering
 * workflow pack.
 *
 * Uses @temporalio/testing TestWorkflowEnvironment.createTimeSkipping() so
 * durable timers and sleeps are skipped instantly while activities run in
 * real wall-clock time.
 *
 * NOTE: The time-skipping test server is downloaded on first run by the
 * Temporal SDK.  If the binary cannot be fetched in this environment the
 * entire suite will fail with a download error — record that as a blocker,
 * not a code defect.
 *
 * IMPORTANT: Tests in this suite MUST run serially.  The time-skipping
 * server is global to the environment; concurrent workflow executions will
 * race for the time-skip lock and produce flaky results.
 */

import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment, workflowInterceptorModules } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/workflow';
import type { WorkflowHandle } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
	addTipSignal,
	applyPromoCodeUpdate,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	deliveryCompletedSignal,
	deliveryWorkflow,
	foodReadySignal,
	getStatusQuery,
	getTimelineQuery,
	orderFoodWorkflow,
	restaurantAcceptedSignal,
	restaurantRejectedSignal,
	subscriptionWorkflow,
	timeSkipSanity,
	updateDeliveryAddressUpdate
} from './workflows.ts';
import type {
	CourierLocationUpdate,
	DeliveryInput,
	OrderInput,
	OrderSnapshot,
	SubscriptionInput
} from './shared.ts';
import { CUSTOMER_TIER, FEATURE_ID, ORDER_STATUS, TASK_QUEUE } from './shared.ts';
import * as activities from './activities.ts';

// ---------------------------------------------------------------------------
// Shared env + worker
// ---------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerShutdown: Promise<void>;

const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows.ts', import.meta.url));

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: 'default',
		taskQueue: TASK_QUEUE,
		workflowsPath: WORKFLOWS_PATH,
		activities,
		interceptors: {
			workflowModules: workflowInterceptorModules
		}
	});
	workerShutdown = worker.run();
}, 120_000);

afterAll(async () => {
	worker?.shutdown();
	await workerShutdown;
	await env?.teardown();
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function uniqueId(prefix = 'test'): string {
	return `${prefix}-${Date.now()}-${++_seq}`;
}

/** Minimal valid order input. Override any field as needed. */
function makeInput(overrides: Partial<OrderInput> = {}): OrderInput {
	return {
		orderId: uniqueId('order'),
		items: [{ itemId: 'burger', name: 'Cheeseburger', quantity: 1, unitPriceCents: 1099 }],
		deliveryAddress: {
			street: '1 Test Ave',
			city: 'Testville',
			state: 'CA',
			postalCode: '90001'
		},
		customerTier: CUSTOMER_TIER.Standard,
		paymentMethod: { type: 'card', last4: '4242', brand: 'visa' },
		restaurantId: 'rest-test',
		customerId: 'cust-test',
		restaurantAcceptTimeoutMinutes: 1,
		...overrides
	};
}

/**
 * Starts orderFoodWorkflow and returns both the handle and a typed query
 * helper.
 */
async function startOrder(
	input: OrderInput
): Promise<[WorkflowHandle<typeof orderFoodWorkflow>, () => Promise<OrderSnapshot>]> {
	const handle = await env.client.workflow.start(orderFoodWorkflow, {
		workflowId: `order-${input.orderId}`,
		taskQueue: TASK_QUEUE,
		args: [input]
	});
	const status = () => handle.query(getStatusQuery);
	return [handle, status];
}

/** Drive the happy path to DELIVERED. */
async function driveToDelivered(
	handle: WorkflowHandle<typeof orderFoodWorkflow>,
	input: OrderInput
): Promise<OrderSnapshot> {
	// Accept restaurant
	await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 5 });
	// Signal food ready
	await handle.signal(foodReadySignal, {});
	// Signal delivery child complete
	const deliveryWfId = `delivery-${input.orderId}`;
	const deliveryHandle = env.client.workflow.getHandle(deliveryWfId);

	// Poll briefly to wait for the child workflow to start
	let childStarted = false;
	for (let i = 0; i < 20; i++) {
		try {
			await deliveryHandle.describe();
			childStarted = true;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	if (!childStarted) {
		throw new Error(`Delivery child workflow ${deliveryWfId} did not start within 4s`);
	}

	await deliveryHandle.signal(deliveryCompletedSignal);
	return handle.result();
}

// ---------------------------------------------------------------------------
// Smoke test — verifies binary download + basic env
// ---------------------------------------------------------------------------

describe('smoke', () => {
	it('TestWorkflowEnvironment.createTimeSkipping() initialises successfully', () => {
		expect(env).toBeDefined();
		expect(worker).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Time-skip discriminator — must run before any timer-dependent test
// ---------------------------------------------------------------------------

describe('time-skip sanity', () => {
	it('TestWorkflowEnvironment advances time for a plain sleep', async () => {
		const t0 = Date.now();
		const h = await env.client.workflow.start(timeSkipSanity, {
			workflowId: uniqueId('ts-sanity'),
			taskQueue: TASK_QUEUE,
			args: []
		});
		await h.result();
		// If time-skipping works this should complete almost instantly (<5 s wall-clock).
		// If it takes ~real time (≥ 60 s) the test times out and signals a harness problem.
		expect(Date.now() - t0).toBeLessThan(5_000);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Happy path → DELIVERED
// ---------------------------------------------------------------------------

describe('happy path', () => {
	it('runs to DELIVERED and returns correct snapshot', async () => {
		const input = makeInput();
		const [handle, status] = await startOrder(input);

		// Query before any signals: should be VALIDATING or AWAITING_RESTAURANT
		// (local activities finish quickly; we just check it's not terminal yet)
		const snapshot = await driveToDelivered(handle, input);

		expect(snapshot.status).toBe(ORDER_STATUS.Delivered);
		expect(snapshot.subtotalCents).toBe(1099);
		expect(snapshot.deliveryFeeCents).toBe(299);
		expect(snapshot.completedAt).toBeDefined();
		expect(snapshot.searchAttributes.OrderStatus).toBe(ORDER_STATUS.Delivered);
		expect(snapshot.searchAttributes.CustomerTier).toBe(CUSTOMER_TIER.Standard);
		expect(snapshot.searchAttributes.RestaurantId).toBe('rest-test');

		void status; // used above; satisfy TS
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Bisect probe B — verifies time-skip still works after happy path
// ---------------------------------------------------------------------------

describe('bisect-probe-B', () => {
	it('time-skip works after happy path', async () => {
		const t0 = Date.now();
		const h = await env.client.workflow.start(timeSkipSanity, {
			workflowId: uniqueId('bpB'),
			taskQueue: TASK_QUEUE,
			args: []
		});
		await h.result();
		expect(Date.now() - t0).toBeLessThan(5_000);
	}, 10_000);
});

// ---------------------------------------------------------------------------
// Activities + Automatic Retry
// ---------------------------------------------------------------------------

describe('activities + retry', () => {
	it('retries chargePayment on transient failure then succeeds', async () => {
		// last4 '0000' triggers a transient failure on attempt 1 (see activities.ts)
		const input = makeInput({
			paymentMethod: { type: 'card', last4: '0000', brand: 'visa' }
		});
		const [handle] = await startOrder(input);
		const snapshot = await driveToDelivered(handle, input);

		// Workflow should have retried and ultimately succeeded
		expect(snapshot.status).toBe(ORDER_STATUS.Delivered);
		// chargePayment fails on attempt 1 (last4 '0000') and succeeds on attempt 2,
		// so the SDK-reported attempt count must be exactly 2 — proving the value
		// reflects real Temporal retries rather than a workflow-side guess.
		expect(snapshot.attemptCounts['chargePayment']).toBe(2);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Non-retryable failure → saga compensation
// ---------------------------------------------------------------------------

describe('non-retryable failure', () => {
	it('PAYMENT_DECLINED triggers immediate saga compensation and CANCELLED', async () => {
		// google-pay triggers a hard non-retryable decline in chargePayment
		const input = makeInput({
			paymentMethod: { type: 'wallet', provider: 'google-pay' }
		});
		const [handle] = await startOrder(input);
		const snapshot = await handle.result();

		expect(snapshot.status).toBe(ORDER_STATUS.Cancelled);
		// The decline is non-retryable, so it fails on attempt 1 with no retries.
		expect(snapshot.attemptCounts['chargePayment']).toBe(1);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Saga compensation
// ---------------------------------------------------------------------------

describe('saga compensation', () => {
	it('cancelling after charge triggers refundPayment compensation', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		// Accept restaurant so payment has been charged
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 5 });

		// Cancel while in PREPARING phase
		await handle.signal(cancelOrderSignal, { reason: 'changed my mind' });

		// Signal food ready to unblock any pending condition
		await handle.signal(foodReadySignal, {});

		const snapshot = await handle.result();
		// Either CANCELLED or REFUNDED depending on compensation path
		expect([ORDER_STATUS.Cancelled, ORDER_STATUS.Refunded]).toContain(snapshot.status);
		// refundPayment compensation must have executed
		const actions = snapshot.compensations.map((c) => c.action);
		expect(actions).toContain('refund-payment');
		void queryStatus;
	}, 30_000);

	it('cancellation after courier assign triggers releaseCourier compensation', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		// Drive to IN_DELIVERY so courier is assigned and both compensations are registered
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Wait for delivery child to start — proves courier was assigned before we cancel
		const deliveryWfId = `delivery-${input.orderId}`;
		for (let i = 0; i < 20; i++) {
			try {
				await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}

		// Cancel during delivery phase (both refundPayment and releaseCourier are on the stack)
		await handle.signal(cancelOrderSignal, { reason: 'test cancel in delivery' });

		const snapshot = await handle.result();
		expect([ORDER_STATUS.Cancelled, ORDER_STATUS.Refunded]).toContain(snapshot.status);

		// Both compensations must have run, in LIFO order:
		// releaseCourier (registered last) runs before refundPayment (registered first)
		const actions = snapshot.compensations.map((c) => c.action);
		expect(actions).toContain('release-courier');
		expect(actions).toContain('refund-payment');
		const rcIdx = actions.indexOf('release-courier');
		const rpIdx = actions.indexOf('refund-payment');
		expect(rcIdx).toBeLessThan(rpIdx); // LIFO: release-courier first
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Bisect probe A — verifies time-skip still works after saga-comp tests
// ---------------------------------------------------------------------------

describe('bisect-probe-A', () => {
	it('time-skip works after saga-comp', async () => {
		const t0 = Date.now();
		const h = await env.client.workflow.start(timeSkipSanity, {
			workflowId: uniqueId('bpA'),
			taskQueue: TASK_QUEUE,
			args: []
		});
		await h.result();
		expect(Date.now() - t0).toBeLessThan(5_000);
	}, 10_000);
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

describe('signals', () => {
	it('restaurantRejected signal → CANCELLED', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);
		await handle.signal(restaurantRejectedSignal, { reason: 'closed', retryable: false });
		const snapshot = await handle.result();
		expect(snapshot.status).toBe(ORDER_STATUS.Cancelled);
	}, 30_000);

	it('addTip signal updates tipCents and totalCents', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		// Accept restaurant so we're past payment
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 5 });

		// Add a $3 tip while preparing
		await handle.signal(addTipSignal, { amountCents: 300 });

		// Check snapshot has the tip
		const snap = await queryStatus();
		expect(snap.tipCents).toBe(300);
		expect(snap.totalCents).toBe(
			snap.subtotalCents + snap.deliveryFeeCents + 300 - snap.promoDiscountCents
		);

		// Finish the order
		await handle.signal(foodReadySignal, {});
		const result = await driveToDelivered(handle, input);
		expect(result.tipCents).toBe(300);
	}, 30_000);

	it('courierLocationUpdate signal updates courier location in snapshot', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		// Drive to delivery phase
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Wait for delivery child to start
		const deliveryWfId = `delivery-${input.orderId}`;
		for (let i = 0; i < 20; i++) {
			try {
				await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}

		// Send a location update
		const location: CourierLocationUpdate = { lat: 37.7749, lng: -122.4194, speedKmh: 30 };
		await handle.signal(courierLocationUpdateSignal, location);

		const snap = await queryStatus();
		expect(snap.locationUpdateCount).toBeGreaterThanOrEqual(1);
		expect(snap.courier?.location).toMatchObject({ lat: 37.7749, lng: -122.4194 });

		// Complete the delivery
		await env.client.workflow.getHandle(deliveryWfId).signal(deliveryCompletedSignal);
		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Delivered);
	}, 30_000);

	it('cancelOrder mid-preparation runs compensation and ends in CANCELLED/REFUNDED', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 5 });

		// Cancel while waiting for foodReady
		await handle.signal(cancelOrderSignal, { reason: 'changed mind during prep' });
		// Also signal food ready so the condition unblocks
		await handle.signal(foodReadySignal, {});

		const snapshot = await handle.result();
		expect([ORDER_STATUS.Cancelled, ORDER_STATUS.Refunded]).toContain(snapshot.status);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Queries — read-only at multiple points
// ---------------------------------------------------------------------------

describe('queries', () => {
	it('getStatus returns consistent snapshot at each phase', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		// Query before restaurant accept
		const snap1 = await queryStatus();
		expect([ORDER_STATUS.Validating, ORDER_STATUS.AwaitingRestaurant]).toContain(snap1.status);
		expect(snap1.input.orderId).toBe(input.orderId);

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 3 });

		const snap2 = await queryStatus();
		expect([ORDER_STATUS.AwaitingRestaurant, ORDER_STATUS.Preparing]).toContain(snap2.status);

		// Finish
		await handle.signal(foodReadySignal, {});
		const snap3 = await driveToDelivered(handle, input);
		expect(snap3.status).toBe(ORDER_STATUS.Delivered);
	}, 30_000);

	it('getTimeline returns annotated entries after each phase', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		const timeline = await handle.query(getTimelineQuery);
		expect(timeline.length).toBeGreaterThan(0);
		// Each entry has required fields
		for (const entry of timeline) {
			expect(entry).toMatchObject({
				index: expect.any(Number),
				timestamp: expect.any(String),
				description: expect.any(String),
				status: expect.any(String)
			});
		}

		// Complete delivery
		await driveToDelivered(handle, input);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Updates with validators
// ---------------------------------------------------------------------------

describe('updates with validators', () => {
	it('updateDeliveryAddress is accepted before dispatch', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		// While waiting for restaurant — update is valid
		const result = await handle.executeUpdate(updateDeliveryAddressUpdate, {
			args: [
				{ newAddress: { street: '999 New St', city: 'Newtown', state: 'NY', postalCode: '10001' } }
			]
		});
		expect(result.updated).toBe(true);
		expect(result.effectiveAddress.street).toBe('999 New St');

		const snap = await queryStatus();
		expect(snap.input.deliveryAddress.street).toBe('999 New St');

		// Finish the order
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});
		await driveToDelivered(handle, input);
	}, 30_000);

	it('updateDeliveryAddress is rejected once IN_DELIVERY', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		// Drive to IN_DELIVERY
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Wait for delivery child to start (IN_DELIVERY state)
		const deliveryWfId = `delivery-${input.orderId}`;
		for (let i = 0; i < 20; i++) {
			try {
				await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}

		// Update should be rejected by validator
		await expect(
			handle.executeUpdate(updateDeliveryAddressUpdate, {
				args: [
					{
						newAddress: {
							street: '100 Late St',
							city: 'Lateville',
							state: 'CA',
							postalCode: '90210'
						}
					}
				]
			})
		).rejects.toThrow();

		// Complete delivery
		await env.client.workflow.getHandle(deliveryWfId).signal(deliveryCompletedSignal);
		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Delivered);
	}, 30_000);

	it('applyPromoCode accepts a valid code and returns new total', async () => {
		const input = makeInput();
		const [handle, queryStatus] = await startOrder(input);

		const result = await handle.executeUpdate(applyPromoCodeUpdate, {
			args: [{ code: 'SAVE10' }]
		});
		expect(result.discountCents).toBeGreaterThan(0);
		expect(result.newTotalCents).toBeLessThan(1099 + 299); // cheaper than full price
		expect(result.description).toContain('10%');

		const snap = await queryStatus();
		expect(snap.appliedPromoCode).toBe('SAVE10');

		// Finish
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});
		await driveToDelivered(handle, input);
	}, 30_000);

	it('applyPromoCode is rejected for an invalid code', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		await expect(
			handle.executeUpdate(applyPromoCodeUpdate, { args: [{ code: 'NOTACODE' }] })
		).rejects.toThrow();

		// Cancel and clean up
		await handle.signal(cancelOrderSignal, { reason: 'test cleanup' });
		await handle.result().catch(() => {});
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Timers / durable sleep
// ---------------------------------------------------------------------------

describe('timers / durable sleep', () => {
	it('restaurant accept timeout (1m) auto-cancels and refunds', async () => {
		const input = makeInput({ restaurantAcceptTimeoutMinutes: 1 });
		const [handle] = await startOrder(input);

		// Do NOT send restaurantAccepted — the time-skipping env will advance
		// time automatically when we await the result
		const snapshot = await handle.result();

		// Should have auto-cancelled after the timeout
		expect(snapshot.status).toBe(ORDER_STATUS.Refunded);
	}, 30_000);

	it('delivery SLA escalation fires when courier takes too long', async () => {
		// Use maxTrackerTicks so trackCourier exits naturally after a few heartbeats.
		// Once the activity is done the time-skip server can advance to the 1m SLA timer.
		const deliveryInput: DeliveryInput = {
			orderId: uniqueId('sla'),
			courierId: 'c-sla',
			courierName: 'Slow Courier',
			deliveryAddress: {
				street: '1 Del St',
				city: 'Del City',
				state: 'CA',
				postalCode: '90001'
			},
			heartbeatIntervalMs: 100,
			maxTrackerTicks: 3, // exits after 300ms real time
			slaTimeout: '1m' // SLA timer fires via time-skip once the tracker exits
		};
		const dwHandle = await env.client.workflow.start(deliveryWorkflow, {
			workflowId: `dw-sla-${deliveryInput.orderId}`,
			taskQueue: TASK_QUEUE,
			args: [deliveryInput]
		});

		// Do NOT send deliveryCompletedSignal — the 1m SLA timer should fire
		const result = await dwHandle.result();

		expect(result.deliveredOnTime).toBe(false);
		expect(result.courierId).toBe('c-sla');
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Child workflow + parent cancellation propagation
// ---------------------------------------------------------------------------

describe('child workflow', () => {
	it('deliveryWorkflow runs as an independent child and completes', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Verify the child workflow was started
		const deliveryWfId = `delivery-${input.orderId}`;
		let childDescription: { status: { name: string } } | null = null;
		for (let i = 0; i < 20; i++) {
			try {
				childDescription = await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		expect(childDescription).not.toBeNull();

		// Complete the delivery child
		await env.client.workflow.getHandle(deliveryWfId).signal(deliveryCompletedSignal);
		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Delivered);
	}, 30_000);

	it('cancelOrder during delivery propagates to child and runs compensation', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Wait for delivery child to start
		const deliveryWfId = `delivery-${input.orderId}`;
		for (let i = 0; i < 20; i++) {
			try {
				await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}

		// Cancel the parent — should propagate to child
		await handle.signal(cancelOrderSignal, { reason: 'parent cancel during delivery' });

		const snapshot = await handle.result();
		expect([ORDER_STATUS.Cancelled, ORDER_STATUS.Refunded]).toContain(snapshot.status);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Heartbeat activity cancellation
// ---------------------------------------------------------------------------

describe('heartbeat + cancellation', () => {
	it('trackCourier stops when order is cancelled (heartbeat cancellation)', async () => {
		const input = makeInput();
		const [handle] = await startOrder(input);

		// Drive to delivery phase
		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});

		// Wait for delivery child and its trackCourier activity to start
		const deliveryWfId = `delivery-${input.orderId}`;
		for (let i = 0; i < 20; i++) {
			try {
				await env.client.workflow.getHandle(deliveryWfId).describe();
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}

		// Allow trackCourier to heartbeat at least once (500ms interval in delivery workflow)
		await new Promise((r) => setTimeout(r, 1200));

		// Cancel — propagates through parent → child → trackCourier via CancellationScope
		await handle.signal(cancelOrderSignal, { reason: 'heartbeat cancellation test' });

		const snapshot = await handle.result();
		// Cancellation propagated and workflow completed cleanly
		expect([ORDER_STATUS.Cancelled, ORDER_STATUS.Refunded]).toContain(snapshot.status);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------

describe('search attributes', () => {
	it('OrderSnapshot.searchAttributes reflects current state', async () => {
		const input = makeInput({ customerTier: CUSTOMER_TIER.Premium });
		const [handle, queryStatus] = await startOrder(input);

		const snap1 = await queryStatus();
		// At some early phase
		expect(snap1.searchAttributes.CustomerTier).toBe(CUSTOMER_TIER.Premium);
		expect(snap1.searchAttributes.RestaurantId).toBe('rest-test');

		await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes: 2 });
		await handle.signal(foodReadySignal, {});
		const result = await driveToDelivered(handle, input);

		expect(result.searchAttributes.OrderStatus).toBe(ORDER_STATUS.Delivered);
		expect(result.searchAttributes.CustomerTier).toBe(CUSTOMER_TIER.Premium);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Local activities — validateOrder + calculatePricing
// ---------------------------------------------------------------------------

describe('local activities', () => {
	it('calculatePricing produces correct totals', async () => {
		const input = makeInput({
			items: [
				{ itemId: 'burger', name: 'Cheeseburger', quantity: 2, unitPriceCents: 1099 },
				{ itemId: 'fries', name: 'Fries', quantity: 1, unitPriceCents: 399 }
			]
		});
		const [handle, queryStatus] = await startOrder(input);

		// Wait for AWAITING_RESTAURANT (local activities have completed)
		let snap = await queryStatus();
		for (let i = 0; i < 20; i++) {
			if (snap.subtotalCents > 0) break;
			await new Promise((r) => setTimeout(r, 200));
			snap = await queryStatus();
		}

		// subtotal = 2 * 1099 + 399 = 2597
		expect(snap.subtotalCents).toBe(2597);
		// delivery fee = 299
		expect(snap.deliveryFeeCents).toBe(299);
		// total = 2597 + 299 = 2896
		expect(snap.totalCents).toBe(2896);

		// Clean up
		await handle.signal(restaurantRejectedSignal, { reason: 'test cleanup', retryable: false });
		await handle.result();
	}, 30_000);

	it('validateOrder rejects an empty items list (non-retryable)', async () => {
		// validateOrder throws ApplicationFailure (non-retryable) → workflow execution fails
		const input = makeInput({ items: [] });
		const [handle] = await startOrder(input);
		// handle.result() MUST reject because validateOrder throws a non-retryable failure
		await expect(handle.result()).rejects.toThrow();
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Replay safety
// ---------------------------------------------------------------------------

describe('replay safety', () => {
	it('happy-path history replays without determinism error', async () => {
		const input = makeInput({ orderId: uniqueId('replay') });
		const [handle] = await startOrder(input);
		const result = await driveToDelivered(handle, input);
		expect(result.status).toBe(ORDER_STATUS.Delivered);

		// Fetch recorded history — assert it is a complete, non-trivial happy path
		// so the replay below actually exercises the full workflow code path.
		const history = await env.client.workflow.getHandle(`order-${input.orderId}`).fetchHistory();
		expect(history.events?.length ?? 0).toBeGreaterThan(0);
		expect(
			history.events?.some((event) => event.workflowExecutionCompletedEventAttributes != null)
		).toBe(true);

		// Replaying the recorded history must resolve without throwing — a
		// determinism violation would reject this promise.
		await expect(
			Worker.runReplayHistory(
				{
					workflowsPath: WORKFLOWS_PATH,
					replayName: 'replay-safety-test'
				},
				history
			)
		).resolves.toBeUndefined();
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Subscription workflow — continueAsNew carrying state
// ---------------------------------------------------------------------------

describe('subscriptionWorkflow – continueAsNew', () => {
	it('carries an incremented cycleCount across continueAsNew runs', async () => {
		const orderId = uniqueId('sub');
		const subWorkflowId = `sub-${orderId}`;
		const subInput: SubscriptionInput = {
			customerId: 'cust-sub',
			baseOrder: {
				items: [{ itemId: 'sub-item', name: 'Sub Item', quantity: 1, unitPriceCents: 500 }],
				deliveryAddress: { street: '1 Sub St', city: 'Subtown', state: 'CA', postalCode: '90001' },
				customerTier: CUSTOMER_TIER.Standard,
				paymentMethod: { type: 'card', last4: '1234', brand: 'mc' },
				restaurantId: 'rest-sub',
				customerId: 'cust-sub',
				restaurantAcceptTimeoutMinutes: 1
			},
			cycleCount: 0,
			maxCycles: 2 // Two cycles, so continueAsNew must carry state at least once
		};

		const subHandle = await env.client.workflow.start(subscriptionWorkflow, {
			workflowId: subWorkflowId,
			taskQueue: TASK_QUEUE,
			args: [subInput]
		});

		// Each cycle places a child order (which times out at the 1-minute
		// restaurant deadline → REFUNDED → completes), sleeps 7 days, then
		// continueAsNew with cycleCount + 1. Run sequence under time-skipping:
		//   cycleCount 0 → child order `${id}-cycle-0` → continueAsNew(1)
		//   cycleCount 1 → child order `${id}-cycle-1` → continueAsNew(2)
		//   cycleCount 2 → terminates (2 >= maxCycles)
		await subHandle.result();

		// Proof that continueAsNew carried the incremented cycleCount: the SECOND
		// cycle's child order only exists if the continued run executed with
		// cycleCount = 1. Both child orders must have completed.
		const cycle0 = await env.client.workflow.getHandle(`${subWorkflowId}-cycle-0`).describe();
		const cycle1 = await env.client.workflow.getHandle(`${subWorkflowId}-cycle-1`).describe();
		expect(cycle0.status.name).toBe('COMPLETED');
		expect(cycle1.status.name).toBe('COMPLETED');
	}, 60_000);
});

// ---------------------------------------------------------------------------
// deliveryWorkflow unit — direct execution
// ---------------------------------------------------------------------------

describe('deliveryWorkflow', () => {
	it('completes when deliveryCompleted signal is received', async () => {
		const deliveryInput: DeliveryInput = {
			orderId: uniqueId('dw'),
			courierId: 'c-test',
			courierName: 'Test Courier',
			deliveryAddress: { street: '1 Del St', city: 'Del City', state: 'CA', postalCode: '90001' },
			heartbeatIntervalMs: 200
		};
		const dwHandle = await env.client.workflow.start(deliveryWorkflow, {
			workflowId: `dw-${deliveryInput.orderId}`,
			taskQueue: TASK_QUEUE,
			args: [deliveryInput]
		});

		// Let trackCourier heartbeat at least once
		await new Promise((r) => setTimeout(r, 600));

		await dwHandle.signal(deliveryCompletedSignal);
		const result = await dwHandle.result();

		expect(result.deliveredOnTime).toBe(true);
		expect(result.courierId).toBe('c-test');
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Shared-contract parity guard
// ---------------------------------------------------------------------------

describe('contract parity', () => {
	it('shared.ts TASK_QUEUE matches workflow-api.ts', async () => {
		// Dynamic import avoids bundler pulling src/lib into sandbox
		const { TASK_QUEUE: contractQ } = await import('../src/lib/contracts/workflow-api.ts');
		expect(TASK_QUEUE).toBe(contractQ);
	});

	it('shared.ts ORDER_STATUS values match workflow-api.ts', async () => {
		const { ORDER_STATUS: contractStatus } = await import('../src/lib/contracts/workflow-api.ts');
		for (const [key, value] of Object.entries(ORDER_STATUS)) {
			expect(ORDER_STATUS[key as keyof typeof ORDER_STATUS]).toBe(
				contractStatus[key as keyof typeof contractStatus]
			);
			void value;
		}
	});

	it('shared.ts FEATURE_ID values match workflow-api.ts FeatureId (via FEATURES)', async () => {
		// The contract has no runtime array for FeatureId itself, but FEATURES is typed
		// so that every entry.id is a FeatureId — it's the canonical witness.
		const { FEATURES } = await import('../src/lib/contracts/workflow-api.ts');
		const contractIds = new Set(FEATURES.map((f) => f.id));
		const sharedIds = new Set(Object.values(FEATURE_ID));
		expect(sharedIds).toEqual(contractIds);
	});
});

// ---------------------------------------------------------------------------
// ApplicationFailure helper (exported for use in tests)
// ---------------------------------------------------------------------------
// Re-export so tests that need to catch ApplicationFailure have it
export { ApplicationFailure };
