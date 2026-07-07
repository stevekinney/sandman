/**
 * workflow.test.ts — acceptance tests for the Sandman order workflow.
 *
 * Uses @temporalio/testing TestWorkflowEnvironment.createTimeSkipping() so
 * durable timers are skipped instantly while activities run in real
 * wall-clock time.
 *
 * NOTE: The time-skipping test server is downloaded on first run by the
 * Temporal SDK. If the binary cannot be fetched in this environment the
 * entire suite will fail with a download error — record that as a blocker,
 * not a code defect.
 *
 * IMPORTANT: Tests in this suite MUST run serially. The time-skipping
 * server is global to the environment; concurrent workflow executions will
 * race for the time-skip lock and produce flaky results.
 */

import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment, workflowInterceptorModules } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
	cancelOrderSignal,
	deliveryCompletedSignal,
	getStatusQuery,
	orderWorkflow,
	restaurantAcceptedSignal
} from './workflow.ts';
import type { OrderInput } from './shared.ts';
import { ORDER_STATUS, TASK_QUEUE } from './shared.ts';
import * as activities from './activities.ts';

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerShutdown: Promise<void>;

const WORKFLOW_PATH = fileURLToPath(new URL('./workflow.ts', import.meta.url));

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: 'default',
		taskQueue: TASK_QUEUE,
		workflowsPath: WORKFLOW_PATH,
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

let _seq = 0;
function uniqueId(prefix = 'test'): string {
	return `${prefix}-${Date.now()}-${++_seq}`;
}

/** Minimal valid order input. Override any field as needed. */
function makeInput(overrides: Partial<OrderInput> = {}): OrderInput {
	return {
		orderId: uniqueId('order'),
		items: [
			{ name: 'Cheeseburger', quantity: 2, priceCents: 1099 },
			{ name: 'Large fries', quantity: 1, priceCents: 399 }
		],
		cardLast4: '4242',
		...overrides
	};
}

function startOrder(input: OrderInput) {
	return env.client.workflow.start(orderWorkflow, {
		workflowId: `order-${input.orderId}`,
		taskQueue: TASK_QUEUE,
		args: [input]
	});
}

describe('orderWorkflow', () => {
	it('delivers an order on the happy path', async () => {
		const input = makeInput();
		const handle = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal);
		await handle.signal(deliveryCompletedSignal);

		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Delivered);
		expect(result.totalCents).toBe(1099 * 2 + 399);
		expect(result.paymentAttempts).toBe(1);
		expect(result.orderId).toBe(input.orderId);
		expect(result.timeline.at(-1)?.description).toBe('Order delivered');
	});

	it('answers the getStatus query with live state while waiting', async () => {
		const input = makeInput();
		const handle = await startOrder(input);

		// The charge activity runs in real time — poll (capped) until the
		// workflow parks on the restaurant wait.
		let snapshot = await handle.query(getStatusQuery);
		for (let attempt = 0; attempt < 50 && snapshot.status === ORDER_STATUS.Received; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			snapshot = await handle.query(getStatusQuery);
		}
		expect(snapshot.status).toBe(ORDER_STATUS.WaitingForRestaurant);
		expect(snapshot.totalCents).toBe(1099 * 2 + 399);
		expect(snapshot.timeline.length).toBeGreaterThan(0);

		await handle.signal(restaurantAcceptedSignal);
		await handle.signal(deliveryCompletedSignal);
		await handle.result();
	});

	it('retries the flaky card and records the attempt count', async () => {
		const input = makeInput({ cardLast4: '0000' });
		const handle = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal);
		await handle.signal(deliveryCompletedSignal);

		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Delivered);
		expect(result.paymentAttempts).toBe(2);
	});

	it('cancels the order without a refund when the card is declined', async () => {
		const input = makeInput({ cardLast4: '9999' });
		const handle = await startOrder(input);

		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Cancelled);
		expect(result.paymentAttempts).toBe(0);
		expect(result.timeline.at(-1)?.description).toBe('Payment failed — order cancelled');
	});

	it('refunds the payment when the restaurant never accepts', async () => {
		const input = makeInput({ restaurantTimeoutSeconds: 5 });
		const handle = await startOrder(input);

		// Never accept — the time-skipping server fires the durable timer.
		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Refunded);
		expect(result.timeline.at(-1)?.description).toBe(
			'Restaurant never accepted — payment refunded'
		);
	});

	it('refunds and cancels when the customer cancels while waiting', async () => {
		const input = makeInput();
		const handle = await startOrder(input);

		await handle.signal(cancelOrderSignal, { reason: 'Changed my mind' });

		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Cancelled);
		expect(result.cancelReason).toBe('Changed my mind');
		expect(result.timeline.at(-1)?.description).toBe('Cancelled: Changed my mind');
	});

	it('cancels during preparation too', async () => {
		const input = makeInput();
		const handle = await startOrder(input);

		await handle.signal(restaurantAcceptedSignal);
		await handle.signal(cancelOrderSignal, { reason: 'Took too long' });

		const result = await handle.result();
		expect(result.status).toBe(ORDER_STATUS.Cancelled);
		expect(result.cancelReason).toBe('Took too long');
	});
});
