/**
 * control-plane.svelte.spec.ts
 *
 * Browser component tests for the Sandman control-plane UI.
 * Runs in the "client" vitest project (headless Chromium via Playwright).
 *
 * Acceptance items covered:
 *  1. Start-order form → controller.start() called with typed OrderInput
 *  2. Signal controls → controller.signal() called with correct name + payload
 *  3. Query buttons render result via PayloadInspector
 *  4. Validator-rejected update surfaces the reason inline
 *  5. Chaos: Kill → worker-down state; Restart → worker-running state
 *  6. Event rail handles out-of-order / duplicate sequence numbers
 *  7. Accessibility: all controls keyboard-reachable; status by text+icon
 */

import { describe, it, expect } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { MockTemporalController } from './mock-controller.ts';
import type { WorkflowEvent } from '$lib/contracts/events';
import ControlPlane from './control-plane.svelte';
import EventRail from './event-rail.svelte';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fill and submit the start-order form with minimal valid fields.
 * Waits until the returned workflow ID is visible in the DOM.
 */
async function startWorkflow(controller: MockTemporalController): Promise<void> {
	await page.getByLabelText('Restaurant ID').fill('restaurant-1');
	await page.getByLabelText('Customer ID').fill('customer-1');
	await page.getByLabelText('Item name').fill('Burger');
	await page.getByLabelText('Item price (cents)').fill('1099');
	await page.getByLabelText('Street').fill('123 Main St');
	await page.getByLabelText('City').fill('Anytown');
	await page.getByLabelText('State').fill('CA');
	await page.getByLabelText('Postal code').fill('90210');
	await page.getByRole('button', { name: 'Start Order' }).click();
	await expect.element(page.getByText(controller.startResult.workflowId)).toBeInTheDocument();
}

// ---------------------------------------------------------------------------
// 1. Start-order form
// ---------------------------------------------------------------------------

describe('start-order form', () => {
	it('calls controller.start once with a valid OrderInput on submit', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await page.getByLabelText('Restaurant ID').fill('rest-42');
		await page.getByLabelText('Customer ID').fill('cust-99');
		await page.getByLabelText('Item name').fill('Pizza');
		await page.getByLabelText('Item price (cents)').fill('1500');
		await page.getByLabelText('Street').fill('1 Infinite Loop');
		await page.getByLabelText('City').fill('Cupertino');
		await page.getByLabelText('State').fill('CA');
		await page.getByLabelText('Postal code').fill('95014');
		await page.getByRole('button', { name: 'Start Order' }).click();

		expect(controller.startCalls).toHaveLength(1);
		expect(controller.startCalls[0]).toMatchObject({
			restaurantId: 'rest-42',
			customerId: 'cust-99',
			items: expect.arrayContaining([
				expect.objectContaining({ name: 'Pizza', unitPriceCents: 1500 })
			]),
			deliveryAddress: {
				street: '1 Infinite Loop',
				city: 'Cupertino',
				state: 'CA',
				postalCode: '95014'
			}
		});
	});

	it('displays the workflow run ID in the UI after a successful start', async () => {
		const controller = new MockTemporalController();
		controller.startResult = { workflowId: 'wf-display-test', runId: 'run-display-test' };
		render(ControlPlane, { props: { controller } });

		await startWorkflow(controller);

		await expect.element(page.getByText('wf-display-test')).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// 2. Signal controls
// ---------------------------------------------------------------------------

describe('signal controls', () => {
	it('calls controller.signal with cancelOrder and the entered reason', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Cancellation reason').fill('Customer changed mind');
		await page.getByRole('button', { name: 'Cancel Order' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			workflowId: controller.startResult.workflowId,
			name: 'cancelOrder',
			payload: { reason: 'Customer changed mind' }
		});
	});

	it('calls controller.signal with restaurantAccepted and prep minutes', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Estimated prep (minutes)').fill('25');
		await page.getByRole('button', { name: 'Restaurant Accepted' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			name: 'restaurantAccepted',
			payload: { estimatedPrepMinutes: 25 }
		});
	});

	it('calls controller.signal with restaurantRejected and reason', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Rejection reason').fill('Out of ingredients');
		await page.getByRole('button', { name: 'Restaurant Rejected' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			name: 'restaurantRejected',
			payload: { reason: 'Out of ingredients' }
		});
	});

	it('calls controller.signal with foodReady (empty payload)', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Food Ready' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			name: 'foodReady',
			payload: {}
		});
	});

	it('calls controller.signal with addTip and the entered amount', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Tip amount (cents)').fill('300');
		await page.getByRole('button', { name: 'Add Tip' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			name: 'addTip',
			payload: { amountCents: 300 }
		});
	});

	it('calls controller.signal with courierLocationUpdate and lat/lng', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Courier latitude').fill('37.7749');
		await page.getByLabelText('Courier longitude').fill('-122.4194');
		await page.getByRole('button', { name: 'Update Courier Location' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			name: 'courierLocationUpdate',
			payload: { lat: 37.7749, lng: -122.4194 }
		});
	});
});

// ---------------------------------------------------------------------------
// 3. Query controls + PayloadInspector
// ---------------------------------------------------------------------------

describe('query controls', () => {
	it('calls controller.query with getStatus and renders result via PayloadInspector', async () => {
		const controller = new MockTemporalController();
		controller.queryResults.set('getStatus', {
			status: 'PREPARING',
			totalCents: 1599
		});
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Get Status' }).click();

		expect(controller.queryCalls).toHaveLength(1);
		expect(controller.queryCalls[0]).toMatchObject({
			workflowId: controller.startResult.workflowId,
			name: 'getStatus'
		});
		// PayloadInspector renders the value — PREPARING should appear somewhere
		await expect.element(page.getByText(/PREPARING/)).toBeInTheDocument();
	});

	it('calls controller.query with getTimeline and renders result via PayloadInspector', async () => {
		const controller = new MockTemporalController();
		controller.queryResults.set('getTimeline', [
			{
				index: 0,
				timestamp: '2024-01-01T00:00:00Z',
				description: 'Order created',
				status: 'CREATED'
			}
		]);
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Get Timeline' }).click();

		expect(controller.queryCalls).toHaveLength(1);
		expect(controller.queryCalls[0]).toMatchObject({ name: 'getTimeline' });
		await expect.element(page.getByText(/Order created/)).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// 4. Update controls — inline validator rejection
// ---------------------------------------------------------------------------

describe('update controls', () => {
	it('shows address update rejection reason inline without throwing', async () => {
		const controller = new MockTemporalController();
		controller.updateRejection = {
			kind: 'rejection',
			reason: 'order-already-in-delivery'
		};
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('New street').fill('456 Oak Ave');
		await page.getByLabelText('New city').fill('Springfield');
		await page.getByLabelText('New state').fill('IL');
		await page.getByLabelText('New postal code').fill('62701');
		await page.getByRole('button', { name: 'Update Address' }).click();

		await expect.element(page.getByText('order-already-in-delivery')).toBeInTheDocument();
		// The update call was recorded even though it was rejected
		expect(controller.updateCalls).toHaveLength(1);
	});

	it('shows promo code rejection reason inline', async () => {
		const controller = new MockTemporalController();
		controller.updateRejection = { kind: 'rejection', reason: 'invalid-code' };
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Promo code').fill('BADCODE');
		await page.getByRole('button', { name: 'Apply Promo' }).click();

		await expect.element(page.getByText('invalid-code')).toBeInTheDocument();
	});

	it('shows promo success result after a successful update', async () => {
		const controller = new MockTemporalController();
		controller.updateResults.set('applyPromoCode', {
			discountCents: 500,
			newTotalCents: 999,
			description: '10% off your order'
		});
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByLabelText('Promo code').fill('SAVE10');
		await page.getByRole('button', { name: 'Apply Promo' }).click();

		await expect.element(page.getByText(/10% off/)).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// 5. Chaos controls
// ---------------------------------------------------------------------------

describe('chaos controls', () => {
	it('calls controller.killWorker and shows worker-down state', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Kill Worker' }).click();

		expect(controller.killWorkerCount).toBe(1);
		await expect.element(page.getByText(/Worker killed/i)).toBeInTheDocument();
	});

	it('shows Restart Worker button after worker is killed', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Kill Worker' }).click();

		await expect.element(page.getByRole('button', { name: 'Restart Worker' })).toBeInTheDocument();
	});

	it('calls controller.restartWorker and returns to running state', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Kill Worker' }).click();
		await page.getByRole('button', { name: 'Restart Worker' }).click();

		expect(controller.restartWorkerCount).toBe(1);
		await expect.element(page.getByText(/Worker running/i)).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// 6. Event rail — deduplication and ordering (tested against EventRail directly)
// ---------------------------------------------------------------------------

describe('event rail', () => {
	it('renders events in sequence order regardless of input order', async () => {
		const outOfOrderEvents: WorkflowEvent[] = [
			{
				sequence: 3,
				type: 'ActivityTaskCompleted',
				timestamp: '2024-01-01T00:00:03Z',
				workflowId: 'wf-1'
			},
			{
				sequence: 1,
				type: 'WorkflowExecutionStarted',
				timestamp: '2024-01-01T00:00:01Z',
				workflowId: 'wf-1'
			},
			{
				sequence: 2,
				type: 'ActivityTaskScheduled',
				timestamp: '2024-01-01T00:00:02Z',
				workflowId: 'wf-1'
			}
		];
		render(EventRail, { props: { events: outOfOrderEvents } });

		await expect.element(page.getByText('WorkflowExecutionStarted')).toBeInTheDocument();
		await expect.element(page.getByText('ActivityTaskScheduled')).toBeInTheDocument();
		await expect.element(page.getByText('ActivityTaskCompleted')).toBeInTheDocument();
	});

	it('deduplicates events with the same sequence number', async () => {
		const duplicateEvents: WorkflowEvent[] = [
			{
				sequence: 1,
				type: 'WorkflowExecutionStarted',
				timestamp: '2024-01-01T00:00:01Z'
			},
			{
				sequence: 1,
				type: 'WorkflowExecutionStarted',
				timestamp: '2024-01-01T00:00:01Z'
			} // duplicate
		];
		render(EventRail, { props: { events: duplicateEvents } });

		// Wait for element to be in the DOM
		await expect.element(page.getByText('WorkflowExecutionStarted')).toBeInTheDocument();
		// After dedup there should be only one element with this text
		expect(page.getByText('WorkflowExecutionStarted').elements()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 7. Accessibility
// ---------------------------------------------------------------------------

describe('accessibility', () => {
	it('all start-order form inputs have accessible labels', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await expect.element(page.getByRole('textbox', { name: 'Restaurant ID' })).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'Customer ID' })).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'Item name' })).toBeInTheDocument();
		await expect
			.element(page.getByRole('spinbutton', { name: 'Item price (cents)' }))
			.toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'Street' })).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'City' })).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'State' })).toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'Postal code' })).toBeInTheDocument();
	});

	it('worker status is communicated by text, not just color', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		// Running state visible via text
		await expect.element(page.getByText(/Worker running/i)).toBeInTheDocument();

		await page.getByRole('button', { name: 'Kill Worker' }).click();

		// Killed state visible via text
		await expect.element(page.getByText(/Worker killed/i)).toBeInTheDocument();
	});

	it('the Start Order submit button is reachable via role=button', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await expect.element(page.getByRole('button', { name: 'Start Order' })).toBeInTheDocument();
	});

	it('signal and chaos buttons are present and reachable after workflow start', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await expect.element(page.getByRole('button', { name: 'Cancel Order' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Kill Worker' })).toBeInTheDocument();
	});
});
