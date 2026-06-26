/**
 * client.ts — Temporal client helpers for the Sandman sandbox demo script.
 *
 * Run `bun run sandbox-template/client.ts` to place a sample order and drive
 * it through the full lifecycle from the command line.
 */

import { Client, Connection } from '@temporalio/client';
import {
	addTipSignal,
	applyPromoCodeUpdate,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	deliveryCompletedSignal,
	foodReadySignal,
	getStatusQuery,
	getTimelineQuery,
	orderFoodWorkflow,
	restaurantAcceptedSignal,
	updateDeliveryAddressUpdate
} from './workflows.ts';
import type { OrderInput, OrderSnapshot, TimelineEntry } from './shared.ts';
import { CUSTOMER_TIER, TASK_QUEUE } from './shared.ts';

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Creates a connected Temporal `Client` pointing at the local dev server.
 * Close the underlying `Connection` when done.
 */
export async function createClient(address = 'localhost:7233'): Promise<Client> {
	const connection = await Connection.connect({ address });
	return new Client({ connection });
}

// ---------------------------------------------------------------------------
// Workflow starters
// ---------------------------------------------------------------------------

/**
 * Starts an `orderFoodWorkflow` execution and returns a workflow handle.
 * The workflow ID is derived from the order ID for idempotent restarts.
 */
export async function startOrder(client: Client, input: OrderInput) {
	return client.workflow.start(orderFoodWorkflow, {
		workflowId: `order-${input.orderId}`,
		taskQueue: TASK_QUEUE,
		args: [input]
	});
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Signal the workflow that the restaurant has accepted the order. */
export async function acceptRestaurant(
	client: Client,
	workflowId: string,
	estimatedPrepMinutes = 10
) {
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(restaurantAcceptedSignal, { estimatedPrepMinutes });
}

/** Signal the workflow that the kitchen preparation is complete. */
export async function signalFoodReady(client: Client, workflowId: string) {
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(foodReadySignal, {});
}

/** Signal the delivery child workflow that the package has been delivered. */
export async function signalDeliveryCompleted(client: Client, orderId: string) {
	const deliveryWorkflowId = `delivery-${orderId}`;
	const handle = client.workflow.getHandle(deliveryWorkflowId);
	await handle.signal(deliveryCompletedSignal);
}

/** Signal the workflow to cancel the order. */
export async function cancelOrder(client: Client, workflowId: string, reason: string) {
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(cancelOrderSignal, { reason });
}

/** Signal a courier GPS location update. */
export async function updateLocation(client: Client, workflowId: string, lat: number, lng: number) {
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(courierLocationUpdateSignal, { lat, lng });
}

/** Signal that the customer added a tip. */
export async function addTip(client: Client, workflowId: string, amountCents: number) {
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(addTipSignal, { amountCents });
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

/** Send an `updateDeliveryAddress` update and return the result. */
export async function updateAddress(
	client: Client,
	workflowId: string,
	street: string,
	city: string,
	state: string,
	postalCode: string
) {
	const handle = client.workflow.getHandle(workflowId);
	return handle.executeUpdate(updateDeliveryAddressUpdate, {
		args: [{ newAddress: { street, city, state, postalCode } }]
	});
}

/** Send an `applyPromoCode` update and return the new total. */
export async function applyPromo(client: Client, workflowId: string, code: string) {
	const handle = client.workflow.getHandle(workflowId);
	return handle.executeUpdate(applyPromoCodeUpdate, { args: [{ code }] });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Query the current order snapshot. */
export async function queryStatus(client: Client, workflowId: string): Promise<OrderSnapshot> {
	const handle = client.workflow.getHandle(workflowId);
	return handle.query(getStatusQuery);
}

/** Query the annotated event timeline. */
export async function queryTimeline(client: Client, workflowId: string): Promise<TimelineEntry[]> {
	const handle = client.workflow.getHandle(workflowId);
	return handle.query(getTimelineQuery);
}

// ---------------------------------------------------------------------------
// Demo script — runs when executed directly
// ---------------------------------------------------------------------------

async function runDemo(): Promise<void> {
	const client = await createClient();

	const orderId = `demo-${Date.now()}`;
	const input: OrderInput = {
		orderId,
		items: [
			{ itemId: 'burger', name: 'Cheeseburger', quantity: 2, unitPriceCents: 1099 },
			{ itemId: 'fries', name: 'Large Fries', quantity: 1, unitPriceCents: 399 }
		],
		deliveryAddress: {
			street: '123 Demo Street',
			city: 'San Francisco',
			state: 'CA',
			postalCode: '94105'
		},
		customerTier: CUSTOMER_TIER.Standard,
		paymentMethod: { type: 'card', last4: '4242', brand: 'visa' },
		restaurantId: 'rest-demo-burger',
		customerId: 'cust-demo-001',
		restaurantAcceptTimeoutMinutes: 2
	};

	const workflowId = `order-${orderId}`;
	process.stdout.write(`[demo] Starting order workflow: ${workflowId}\n`);
	const handle = await startOrder(client, input);

	process.stdout.write('[demo] Querying initial status...\n');
	const initial = await queryStatus(client, workflowId);
	process.stdout.write(`[demo] Status: ${initial.status}\n`);

	// Drive through the happy path
	await new Promise((r) => setTimeout(r, 500));
	process.stdout.write('[demo] Accepting at restaurant...\n');
	await acceptRestaurant(client, workflowId, 15);

	await new Promise((r) => setTimeout(r, 500));
	process.stdout.write('[demo] Signalling food ready...\n');
	await signalFoodReady(client, workflowId);

	await new Promise((r) => setTimeout(r, 1000));
	process.stdout.write('[demo] Signalling delivery completed...\n');
	await signalDeliveryCompleted(client, orderId);

	const result = await handle.result();
	process.stdout.write(`[demo] Order completed! Final status: ${result.status}\n`);
	process.stdout.write(`[demo] Total: $${(result.totalCents / 100).toFixed(2)}\n`);
}

// Only run the demo when this file is executed directly
if (import.meta.url === new URL(process.argv[1], 'file://').href) {
	runDemo().catch((err) => {
		process.stderr.write(`[demo] Error: ${String(err)}\n`);
		process.exit(1);
	});
}
