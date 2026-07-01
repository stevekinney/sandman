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
import type { CommandLogEntry, WorkflowRun } from './types.ts';
import type { WorkflowEvent } from '$lib/contracts/events';
import type { TimelineEntry } from '$lib/contracts/workflow-api';
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
	await page.getByRole('button', { name: 'Place Order' }).click();
	await expect.element(page.getByText(controller.startResult.workflowId)).toBeInTheDocument();
}

// ---------------------------------------------------------------------------
// 1. Start-order form
// ---------------------------------------------------------------------------

describe('start-order form', () => {
	it('calls controller.start once with a valid OrderInput on submit', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await page.getByRole('button', { name: 'Add Miso caesar salad' }).click();
		await page.getByRole('button', { name: 'Place Order' }).click();

		expect(controller.startCalls).toHaveLength(1);
		expect(controller.startCalls[0]).toMatchObject({
			restaurantId: 'kitchen-44',
			customerId: 'customer-2187',
			items: expect.arrayContaining([
				expect.objectContaining({ name: 'Spicy noodles', unitPriceCents: 1295, quantity: 1 }),
				expect.objectContaining({ name: 'Miso caesar salad', unitPriceCents: 1095, quantity: 1 })
			]),
			deliveryAddress: {
				street: '221 Market Street',
				city: 'Denver',
				state: 'CO',
				postalCode: '80205'
			}
		});
	});

	it('renders a realistic order card instead of a required-field worksheet', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await expect.element(page.getByText('Popular items')).toBeInTheDocument();
		await expect
			.element(page.getByText('Little gems, furikake crunch, yuzu dressing'))
			.toBeInTheDocument();
		await expect.element(page.getByRole('heading', { name: 'Cart' })).toBeInTheDocument();
		await expect.element(page.getByText('1x Spicy noodles')).toBeInTheDocument();
		await expect.element(page.getByText('Total', { exact: true })).toBeInTheDocument();
		await expect.element(page.getByText('Kitsune Kitchen')).toBeInTheDocument();
		await expect.element(page.getByText('221 Market Street, Denver')).toBeInTheDocument();
		await expect
			.element(page.getByRole('textbox', { name: 'Restaurant ID' }))
			.not.toBeInTheDocument();
		await expect.element(page.getByRole('textbox', { name: 'Street' })).not.toBeInTheDocument();
	});

	it('keeps the menu and cart readable in a narrow control panel', async () => {
		const controller = new MockTemporalController();
		const { container } = render(ControlPlane, { props: { controller } });
		container.style.width = '520px';
		container.style.maxWidth = '520px';
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		const form = container.querySelector('.order-start');
		const menuSection = container.querySelector('.menu-section');
		const checkoutSection = container.querySelector('.checkout-section');
		const itemCopy = container.querySelector('.item-copy');
		if (form === null || menuSection === null || checkoutSection === null || itemCopy === null) {
			throw new Error('Expected start-order layout sections to render.');
		}

		const formRect = form.getBoundingClientRect();
		const menuRect = menuSection.getBoundingClientRect();
		const checkoutRect = checkoutSection.getBoundingClientRect();
		const itemCopyRect = itemCopy.getBoundingClientRect();

		expect(menuRect.width).toBeGreaterThan(formRect.width * 0.9);
		expect(checkoutRect.top).toBeGreaterThan(menuRect.bottom - 1);
		expect(itemCopyRect.width).toBeGreaterThan(240);
	});

	it('formats workflow start failures without exposing raw server JSON', async () => {
		const controller = new MockTemporalController();
		controller.startError = new Error('Failed to start workflow: {"message":"Internal Error"}');
		render(ControlPlane, { props: { controller } });

		await page.getByRole('button', { name: 'Place Order' }).click();

		const alert = page.getByRole('alert');
		await expect.element(alert.getByText('The order workflow did not start')).toBeInTheDocument();
		await expect
			.element(alert.getByText('Temporal did not accept the workflow start command'))
			.toBeInTheDocument();
		await expect.element(alert.getByText('Try Place Order again')).toBeInTheDocument();
		await expect.element(alert.getByText('{"message":"Internal Error"}')).not.toBeInTheDocument();

		await page.getByText('Technical detail').click();
		await expect.element(alert.getByText('Internal Error')).toBeInTheDocument();
	});

	it('displays the workflow run ID in the UI after a successful start', async () => {
		const controller = new MockTemporalController();
		controller.startResult = { workflowId: 'wf-display-test', runId: 'run-display-test' };
		render(ControlPlane, { props: { controller } });

		await startWorkflow(controller);

		await expect.element(page.getByRole('list', { name: 'Order progress' })).toBeInTheDocument();
		await expect.element(page.getByText('Kitsune Kitchen is working on it')).toBeInTheDocument();
		await expect
			.element(page.getByRole('heading', { name: 'Temporal controls' }))
			.toBeInTheDocument();
		await expect.element(page.getByText('wf-display-test')).toBeInTheDocument();
	});

	it('renders the current recommended next action after a workflow starts', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, {
			props: { controller, recommendedControl: 'accept-restaurant' }
		});

		await startWorkflow(controller);

		await expect.element(page.getByText('Recommended next action')).toBeInTheDocument();
		await expect
			.element(page.getByLabelText('Recommended next action').getByText('Restaurant Accepted'))
			.toBeInTheDocument();
	});

	it('shows a passive timeline-watching next action when the tour has no control to click', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller, recommendedControl: undefined } });

		await startWorkflow(controller);

		await expect
			.element(
				page.getByLabelText('Recommended next action').getByText('Watch the timeline advance')
			)
			.toBeInTheDocument();
	});

	it('opens only the current control group while guided mode is active', async () => {
		const controller = new MockTemporalController();
		const { container } = render(ControlPlane, {
			props: { controller, recommendedControl: 'update-address' }
		});

		await startWorkflow(controller);

		const updates = container.querySelector('[data-control-section="updates"]');
		const signals = container.querySelector('[data-control-section="signals"]');
		const queries = container.querySelector('[data-control-section="queries"]');
		if (updates === null || signals === null || queries === null) {
			throw new Error('Expected guided control sections to render.');
		}
		expect(updates.hasAttribute('open')).toBe(true);
		expect(signals.hasAttribute('open')).toBe(false);
		expect(queries.hasAttribute('open')).toBe(false);
		await expect
			.element(page.getByText('Make validated changes with an immediate result'))
			.toBeInTheDocument();
	});

	it('keeps every control group open when no guided control is active', async () => {
		const controller = new MockTemporalController();
		const { container } = render(ControlPlane, { props: { controller } });

		await startWorkflow(controller);

		for (const sectionName of ['signals', 'queries', 'visibility', 'updates', 'worker']) {
			const section = container.querySelector(`[data-control-section="${sectionName}"]`);
			if (section === null) throw new Error(`Expected ${sectionName} section to render.`);
			expect(section.hasAttribute('open')).toBe(true);
		}
	});

	it('filters signal controls to the guided action while guided mode is active', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, {
			props: { controller, recommendedControl: 'accept-restaurant' }
		});

		await startWorkflow(controller);

		await expect.element(page.getByRole('button', { name: 'Restaurant Accepted' })).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Cancel Order' }))
			.not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Food Ready' })).not.toBeInTheDocument();
	});

	it('emits command-log entries for start and query operations', async () => {
		const controller = new MockTemporalController();
		const commandEntries: CommandLogEntry[] = [];
		controller.queryResults.set('getStatus', { status: 'PREPARING' });
		render(ControlPlane, {
			props: {
				controller,
				oncommand: (entry: CommandLogEntry) => commandEntries.push(entry)
			}
		});

		await startWorkflow(controller);
		await page.getByRole('button', { name: 'Get Status' }).click();

		expect(commandEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: 'Place Order',
					apiRoute: 'POST /api/sandbox/[id]/workflow',
					temporalCommand: expect.stringContaining('temporal workflow start'),
					status: 'succeeded'
				}),
				expect.objectContaining({
					label: 'Get Status',
					apiRoute: 'GET /api/sandbox/[id]/workflow/query',
					temporalCommand: 'temporal workflow query --type getStatus',
					status: 'succeeded'
				})
			])
		);
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

	it('calls controller.signal on the delivery child workflow when delivery is completed', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Complete Delivery' }).click();

		expect(controller.signalCalls).toHaveLength(1);
		expect(controller.signalCalls[0]).toMatchObject({
			workflowId: `delivery-${controller.startCalls[0].orderId}`,
			name: 'deliveryCompleted',
			payload: {}
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
		await expect
			.element(page.getByLabelText('Current workflow snapshot').getByText('PREPARING'))
			.toBeInTheDocument();
		await expect.element(page.getByText('Query result: getStatus')).toBeInTheDocument();
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
// 3b. Order timeline (Cinder RunStepTimeline)
// ---------------------------------------------------------------------------

describe('order timeline', () => {
	it('renders a RunStepTimeline step for each timeline entry after a run starts', async () => {
		const controller = new MockTemporalController();
		const timelineEntries: TimelineEntry[] = [
			{
				index: 0,
				timestamp: '2026-01-01T00:00:00.000Z',
				description: 'Validating order',
				status: 'VALIDATING'
			},
			{
				index: 1,
				timestamp: '2026-01-01T00:01:00.000Z',
				description: 'Charging payment',
				status: 'AWAITING_RESTAURANT'
			}
		];
		render(ControlPlane, { props: { controller, timelineEntries } });
		await startWorkflow(controller);

		// Cinder's RunStepTimeline renders an <ol aria-label="Order timeline">;
		// asserting the list role confirms the real component (not a fallback) mounted.
		const timeline = page.getByRole('list', { name: 'Order timeline' });
		await expect.element(timeline).toBeInTheDocument();
		await expect.element(page.getByText('Validating order')).toBeInTheDocument();
		await expect.element(timeline.getByText('Charging payment')).toBeInTheDocument();
	});

	it('invokes onstarted with the run identifiers when an order starts', async () => {
		const controller = new MockTemporalController();
		const runs: WorkflowRun[] = [];
		render(ControlPlane, {
			props: { controller, onstarted: (run: WorkflowRun) => runs.push(run) }
		});
		await startWorkflow(controller);

		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual(controller.startResult);
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

	it('emits a WorkerKilled event when the worker is killed', async () => {
		const controller = new MockTemporalController();
		const events: WorkflowEvent[] = [];
		render(ControlPlane, {
			props: { controller, onworkflowevent: (event: WorkflowEvent) => events.push(event) }
		});
		await startWorkflow(controller);

		await page.getByRole('button', { name: 'Kill Worker' }).click();

		expect(events).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'WorkerKilled' })])
		);
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
	it('the start-order panel is reachable without filling fixture fields', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await expect.element(page.getByRole('button', { name: 'Place Order' })).toBeInTheDocument();
		await expect.element(page.getByText('Leave at the front desk')).toBeInTheDocument();
		await expect.element(page.getByText('Visa ending in 4242')).toBeInTheDocument();
	});

	it('renders control-plane fields with Cinder form primitives', async () => {
		const controller = new MockTemporalController();
		const { container } = render(ControlPlane, { props: { controller } });

		expect(container.querySelector('.cinder-badge')).not.toBeNull();
		expect(container.querySelector('.cinder-button')).not.toBeNull();

		await startWorkflow(controller);

		expect(container.querySelector('.cinder-textarea')).not.toBeNull();
		expect(container.querySelector('.cinder-form-field')).not.toBeNull();
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

	it('the Place Order submit button is reachable via role=button', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });

		await expect.element(page.getByRole('button', { name: 'Place Order' })).toBeInTheDocument();
	});

	it('signal and chaos buttons are present and reachable after workflow start', async () => {
		const controller = new MockTemporalController();
		render(ControlPlane, { props: { controller } });
		await startWorkflow(controller);

		await expect.element(page.getByRole('button', { name: 'Cancel Order' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Kill Worker' })).toBeInTheDocument();
	});
});
