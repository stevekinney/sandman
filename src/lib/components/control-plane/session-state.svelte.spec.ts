/**
 * session-state.svelte.spec.ts — browser tests for SessionState.
 * Runs in the "client" vitest project because the class uses Svelte runes.
 *
 * Covers the action → controller → event feed → tour progression loop using
 * the in-memory MockTemporalController.
 */
import { describe, expect, it } from 'vitest';
import type { OrderSnapshot, TimelineEntry } from '$lib/contracts/workflow-api';
import { ORDER_STATUS } from '$lib/contracts/workflow-api';
import { TourState } from '$lib/components/explainer';
import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
import { MockTemporalController } from './mock-controller.ts';
import { SessionState, type NotifyVariant } from './session-state.svelte.ts';

function volatileStorage(): StorageAdapter {
	let progress: TourProgress | null = null;
	return {
		load: () => progress,
		save: (next) => {
			progress = {
				currentStepIndex: next.currentStepIndex,
				completedStepIds: [...next.completedStepIds]
			};
		},
		clear: () => {
			progress = null;
		}
	};
}

function makeSession() {
	const controller = new MockTemporalController();
	const tour = new TourState(volatileStorage());
	const session = new SessionState(controller, tour);
	// The page's status poll flips this once the sandbox reports ready.
	session.sandboxUsable = true;
	const notifications: Array<{ message: string; variant: NotifyVariant }> = [];
	session.notify = (message, variant) => notifications.push({ message, variant });
	return { controller, tour, session, notifications };
}

function timelineEntry(
	index: number,
	status: TimelineEntry['status'],
	eventType?: TimelineEntry['eventType']
): TimelineEntry {
	return {
		index,
		timestamp: new Date(index * 1000).toISOString(),
		description: `entry-${index}`,
		status,
		eventType
	};
}

describe('SessionState', () => {
	it('gates every control until the sandbox reports ready', () => {
		const controller = new MockTemporalController();
		const session = new SessionState(controller, new TourState(volatileStorage()));
		expect(session.canDo('start-order')).toBe(false);
		expect(session.canDo('kill-worker')).toBe(false);
	});

	it('starts idle with everything but start-order gated off', () => {
		const { session } = makeSession();
		expect(session.phase).toBe('idle');
		expect(session.canDo('start-order')).toBe(true);
		expect(session.canDo('accept-restaurant')).toBe(false);
		expect(session.canDo('cancel-order')).toBe(false);
	});

	it('placeOrder starts the workflow, records the run, and advances the tour', async () => {
		const { controller, tour, session } = makeSession();
		await session.placeOrder();

		expect(controller.startCalls).toHaveLength(1);
		expect(session.run).toEqual(controller.startResult);
		expect(session.workflowEvents.at(-1)?.type).toBe('WorkflowExecutionStarted');
		// Step 1 (start-workflow) completes on WorkflowExecutionStarted.
		expect(tour.currentStepIndex).toBe(1);
	});

	it('placeOrder does not fabricate a live worker when one was killed', async () => {
		const { session } = makeSession();
		await session.placeOrder();
		await session.killWorker();
		expect(session.workerOnline).toBe(false);

		// Placing another order starts a workflow but does not restart the worker,
		// so the topology must keep showing it down rather than lying that it came back.
		await session.placeOrder();
		expect(session.workerOnline).toBe(false);
	});

	it('ingestTimeline feeds only new annotated entries into the event feed', async () => {
		const { session } = makeSession();
		await session.placeOrder();
		const before = session.workflowEvents.length;

		const entries = [
			timelineEntry(0, ORDER_STATUS.Created, 'WorkflowExecutionStarted'),
			timelineEntry(1, ORDER_STATUS.Validating), // unannotated — not fed
			timelineEntry(2, ORDER_STATUS.Validating, 'ActivityTaskCompleted')
		];
		session.ingestTimeline(entries);
		expect(session.timelineEntries).toEqual(entries);
		expect(session.workflowEvents.length).toBe(before + 2);

		// Re-ingesting the same poll result must not duplicate events.
		session.ingestTimeline(entries);
		expect(session.workflowEvents.length).toBe(before + 2);
	});

	it('derives the phase from the latest timeline entry', async () => {
		const { session } = makeSession();
		await session.placeOrder();
		session.ingestTimeline([timelineEntry(0, ORDER_STATUS.AwaitingRestaurant, 'TimerStarted')]);
		expect(session.phase).toBe(ORDER_STATUS.AwaitingRestaurant);
		expect(session.canDo('accept-restaurant')).toBe(true);
	});

	it('acceptRestaurant signals the running workflow', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.acceptRestaurant();
		expect(controller.signalCalls).toEqual([
			{
				workflowId: controller.startResult.workflowId,
				name: 'restaurantAccepted',
				payload: { estimatedPrepMinutes: 20 }
			}
		]);
	});

	it('rejectRestaurant signals the running workflow', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.rejectRestaurant();
		expect(controller.signalCalls.at(-1)).toEqual({
			workflowId: controller.startResult.workflowId,
			name: 'restaurantRejected',
			payload: { reason: 'Kitchen is over capacity', retryable: false }
		});
	});

	it('updateLocation signals the courier location', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.updateLocation();
		expect(controller.signalCalls.at(-1)).toEqual({
			workflowId: controller.startResult.workflowId,
			name: 'courierLocationUpdate',
			payload: { lat: 39.7392, lng: -104.9903, speedKmh: 24 }
		});
	});

	it('applyPromo updates the workflow and summarizes the discount', async () => {
		const { controller, session, notifications } = makeSession();
		controller.updateResults.set('applyPromoCode', {
			discountCents: 500,
			newTotalCents: 1500,
			description: '10% off your order'
		});
		await session.placeOrder();
		await session.applyPromo();

		expect(controller.updateCalls.at(-1)).toEqual({
			workflowId: controller.startResult.workflowId,
			name: 'applyPromoCode',
			input: { code: 'SAVE10' }
		});
		expect(notifications.at(-1)?.variant).toBe('success');
		expect(notifications.at(-1)?.message).toContain('$15.00');
	});

	it('applyPromo surfaces a validator rejection as a toast instead of an error', async () => {
		const { controller, session, notifications } = makeSession();
		controller.updateRejection = { kind: 'rejection', reason: 'invalid-code' };
		await session.placeOrder();
		await session.applyPromo();

		const rejection = notifications.at(-1);
		expect(rejection?.variant).toBe('danger');
		expect(rejection?.message).toContain('invalid-code');
	});

	it('completeDelivery signals the child delivery workflow', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.completeDelivery();
		const orderId = controller.startCalls[0].orderId;
		expect(controller.signalCalls.at(-1)).toEqual({
			workflowId: `delivery-${orderId}`,
			name: 'deliveryCompleted',
			payload: {}
		});
	});

	it('surfaces a validator rejection as a toast instead of an error', async () => {
		const { controller, session, notifications } = makeSession();
		controller.updateRejection = { kind: 'rejection', reason: 'order-already-in-delivery' };
		await session.placeOrder();
		await session.updateAddress();

		const rejection = notifications.at(-1);
		expect(rejection?.variant).toBe('danger');
		expect(rejection?.message).toContain('order-already-in-delivery');
		// The rejection is a lesson, not an unhandled failure — no event is fed.
		expect(session.workflowEvents.some((event) => event.type.includes('Update'))).toBe(false);
	});

	it('queryStatus emits a QueryCompleted event and summarizes the snapshot', async () => {
		const { controller, session, notifications } = makeSession();
		controller.queryResults.set('getStatus', {
			status: ORDER_STATUS.Preparing,
			totalCents: 2019
		} as Partial<OrderSnapshot>);
		await session.placeOrder();
		await session.queryStatus();

		expect(session.workflowEvents.at(-1)?.type).toBe('QueryCompleted');
		expect(notifications.at(-1)?.message).toContain('$20.19');
	});

	it('queryTimeline emits a QueryCompleted event and ingests the returned entries', async () => {
		const { controller, session, notifications } = makeSession();
		await session.placeOrder();
		const entries = [
			timelineEntry(0, ORDER_STATUS.Created, 'WorkflowExecutionStarted'),
			timelineEntry(1, ORDER_STATUS.Validating, 'ActivityTaskCompleted')
		];
		controller.queryResults.set('getTimeline', entries);

		await session.queryTimeline();

		expect(controller.queryCalls.at(-1)).toEqual({
			workflowId: controller.startResult.workflowId,
			name: 'getTimeline'
		});
		expect(session.timelineEntries).toEqual(entries);
		expect(session.workflowEvents.at(-1)?.type).toBe('QueryCompleted');
		expect(notifications.at(-1)?.message).toContain('2 entries');
	});

	it('listVisibility filters by the current order status and search attributes', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		// The latest timeline entry supplies the current order status filter.
		session.ingestTimeline([timelineEntry(0, ORDER_STATUS.Preparing)]);

		await session.listVisibility();

		const call = controller.visibilityCalls.at(-1);
		expect(call?.filter.status).toBe(ORDER_STATUS.Preparing);
		expect(call?.filter.customerTier).toBe(session.activeOrder?.customerTier);
		expect(call?.filter.restaurantId).toBe(session.activeOrder?.restaurantId);
	});

	it('kill and restart round-trip the worker with recovery events', async () => {
		const { controller, tour, session } = makeSession();
		await session.placeOrder();

		await session.killWorker();
		expect(controller.killWorkerCount).toBe(1);
		expect(session.workerOnline).toBe(false);
		expect(session.workflowEvents.at(-1)?.type).toBe('WorkerKilled');
		// While offline, the kill-worker control becomes "restart" and stays usable.
		expect(session.canDo('kill-worker')).toBe(true);

		// Walk the tour to the durable-recovery step to verify WorkerRestarted advances it.
		const restore = tour.currentStepIndex;
		await session.restartWorker();
		expect(controller.restartWorkerCount).toBe(1);
		expect(session.workerOnline).toBe(true);
		expect(session.workflowEvents.at(-1)?.type).toBe('WorkerRestarted');
		expect(tour.currentStepIndex).toBeGreaterThanOrEqual(restore);
	});

	it('stop and start round-trip the Temporal server with persisted state', async () => {
		const { controller, session, notifications } = makeSession();
		await session.placeOrder();

		await session.stopServer();
		expect(controller.stopServerCount).toBe(1);
		expect(session.serverOnline).toBe(false);
		// The worker dies with its server connection (backend kills it too).
		expect(session.workerOnline).toBe(false);
		expect(session.workflowEvents.at(-1)?.type).toBe('ServerStopped');
		expect(notifications.at(-1)?.variant).toBe('warning');
		// Every workflow control is gated off while the server is down.
		expect(session.canDo('query-status')).toBe(false);
		expect(session.canDo('kill-worker')).toBe(false);

		await session.startServer();
		expect(controller.startServerCount).toBe(1);
		expect(session.serverOnline).toBe(true);
		expect(session.workerOnline).toBe(true);
		expect(session.workflowEvents.at(-1)?.type).toBe('ServerStarted');
		expect(session.canDo('query-status')).toBe(true);
	});

	it('notifies with danger when a controller call fails', async () => {
		const { controller, session, notifications } = makeSession();
		controller.startError = new Error('temporal exploded');
		await session.placeOrder();
		expect(session.run).toBeNull();
		expect(notifications.at(-1)).toEqual({ message: 'temporal exploded', variant: 'danger' });
	});

	it('reset clears the run and tour without fabricating backend liveness', async () => {
		const { tour, session } = makeSession();
		await session.placeOrder();
		expect(session.run).not.toBeNull();
		// Stop the server: the backend process is now genuinely down.
		await session.stopServer();
		expect(session.serverOnline).toBe(false);

		session.reset();
		expect(session.run).toBeNull();
		expect(session.workflowEvents).toEqual([]);
		expect(session.timelineEntries).toEqual([]);
		expect(session.phase).toBe('idle');
		expect(tour.currentStepIndex).toBe(0);
		// Regression: reset is client-only, so it must NOT claim the stopped
		// server came back — the topology keeps reflecting the real backend and
		// start-order stays gated until the learner restarts it.
		expect(session.serverOnline).toBe(false);
		expect(session.serverPending).toBeNull();
		expect(session.canDo('start-order')).toBe(false);
	});

	describe('reconcileLiveness', () => {
		it('adopts backend liveness while idle', () => {
			const { session } = makeSession();
			session.reconcileLiveness({ serverOnline: false, workerOnline: false });
			expect(session.serverOnline).toBe(false);
			expect(session.workerOnline).toBe(false);

			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.serverOnline).toBe(true);
			expect(session.workerOnline).toBe(true);
		});

		it('recovers worker liveness a backend save-restart applied out of band', () => {
			const { session } = makeSession();
			// Worker shown down (killed earlier); an editor save restarted it on the
			// backend via the files route, which never touches this client.
			session.workerOnline = false;
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workerOnline).toBe(true);
		});

		it('skips reconciliation while an action is in flight so it cannot flicker', () => {
			const { session } = makeSession();
			session.workerOnline = false;

			// A poll that raced an in-flight control/server op must not overwrite
			// the optimistic state.
			session.pendingControl = 'kill-worker';
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workerOnline).toBe(false);

			session.pendingControl = null;
			session.workerRestarting = true;
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workerOnline).toBe(false);

			session.workerRestarting = false;
			session.serverPending = 'starting';
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workerOnline).toBe(false);

			// Once nothing is in flight, the next poll reconciles.
			session.serverPending = null;
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workerOnline).toBe(true);
		});
	});
});
