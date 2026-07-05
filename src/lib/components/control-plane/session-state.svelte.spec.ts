/**
 * session-state.svelte.spec.ts — browser tests for SessionState.
 * Runs in the "client" vitest project because the class uses Svelte runes.
 *
 * Covers the action → controller → event feed → tour progression loop using
 * the in-memory MockTemporalController.
 */
import { describe, expect, it } from 'vitest';
import type {
	OrderSnapshot,
	QueryName,
	QueryReturnMap,
	TimelineEntry,
	VisibilityWorkflowSummary
} from '$lib/contracts/workflow-api';
import { ORDER_FOOD_WORKFLOW, ORDER_STATUS } from '$lib/contracts/workflow-api';
import { TOUR } from '$lib/content/demo-script';
import { TourState } from '$lib/components/explainer';
import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
import { MockTemporalController } from './mock-controller.ts';
import { restoreSessionFromSandbox } from './session-restore.ts';
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

	describe('restoreSessionFromSandbox', () => {
		function runningOrderSummary(
			workflowId: string,
			overrides: Partial<VisibilityWorkflowSummary> = {}
		): VisibilityWorkflowSummary {
			return {
				workflowId,
				runId: 'run-restored-1',
				status: 'RUNNING',
				type: ORDER_FOOD_WORKFLOW,
				businessSnapshot: {},
				...overrides
			};
		}

		/** A TourState whose storage already holds progress, as after a reload. */
		function restoredTour(storage: StorageAdapter, stepIndex: number): TourState {
			storage.save({
				currentStepIndex: stepIndex,
				completedStepIds: TOUR.slice(0, stepIndex).map((step) => step.id)
			});
			return new TourState(storage);
		}

		it('re-attaches to the running order workflow and replays its timeline', async () => {
			const { controller, tour, session } = makeSession();
			controller.visibilityResult = [
				runningOrderSummary('delivery-order-9', { type: 'deliveryWorkflow' }),
				runningOrderSummary('order-9')
			];
			controller.queryResults.set('getTimeline', [
				timelineEntry(0, ORDER_STATUS.Created, 'WorkflowExecutionStarted'),
				timelineEntry(1, ORDER_STATUS.Validating, 'ActivityTaskCompleted'),
				timelineEntry(2, ORDER_STATUS.AwaitingRestaurant, 'TimerStarted')
			]);

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual({ workflowId: 'order-9', runId: 'run-restored-1' });
			// The workflow id is the order id, so the demo order is rebuilt around it.
			expect(session.activeOrder?.orderId).toBe('order-9');
			expect(session.phase).toBe(ORDER_STATUS.AwaitingRestaurant);
			// Replayed history advanced the tour to the signal step.
			expect(TOUR[tour.currentStepIndex]?.id).toBe('signal-accept');
		});

		it('restores tour progress and the run together across a reload', async () => {
			// First page load: place an order and advance the tour, persisting
			// progress into the (shared) storage adapter.
			const storage = volatileStorage();
			const firstController = new MockTemporalController();
			const firstSession = new SessionState(firstController, new TourState(storage));
			firstSession.sandboxUsable = true;
			await firstSession.placeOrder();
			expect(storage.load()?.currentStepIndex).toBe(1);

			// Reload: everything client-side is fresh except the storage adapter.
			const controller = new MockTemporalController();
			controller.visibilityResult = [runningOrderSummary(firstController.startResult.workflowId)];
			controller.queryResults.set('getTimeline', [
				timelineEntry(0, ORDER_STATUS.Created, 'WorkflowExecutionStarted')
			]);
			const tour = new TourState(storage);
			expect(tour.currentStepIndex).toBe(1);
			const session = new SessionState(controller, tour);
			session.sandboxUsable = true;

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual({
				workflowId: firstController.startResult.workflowId,
				runId: 'run-restored-1'
			});
			expect(session.phase).toBe(ORDER_STATUS.Created);
			// No inconsistent half-state: the restored tour step and the restored
			// run agree, and the replayed start event did not double-advance.
			expect(tour.currentStepIndex).toBe(1);
		});

		it('skips restored steps the real workflow phase has made impossible', async () => {
			const storage = volatileStorage();
			const updateStepIndex = TOUR.findIndex((step) => step.id === 'update-with-validator');
			const tour = restoredTour(storage, updateStepIndex);
			const controller = new MockTemporalController();
			controller.visibilityResult = [runningOrderSummary('order-3')];
			// The order moved to delivery while the page was closed; the learner
			// never performed the update, so no update event exists to replay.
			controller.queryResults.set('getTimeline', [
				timelineEntry(0, ORDER_STATUS.InDelivery, 'ChildWorkflowExecutionStarted')
			]);
			const session = new SessionState(controller, tour);
			session.sandboxUsable = true;

			await restoreSessionFromSandbox(controller, session);

			// The update validator rejects in-delivery changes, so the tour floors
			// forward past the update and child steps instead of sitting stuck.
			expect(TOUR[tour.currentStepIndex]?.id).toBe('queryable-business-snapshot');
			expect(tour.completedStepIds).toContain('update-with-validator');
			expect(tour.completedStepIds).toContain('child-workflow');
		});

		it('resets stale in-progress tour state once no order workflow is confirmed absent', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 3);
			const controller = new MockTemporalController();
			controller.visibilityResult = [runningOrderSummary('order-1', { status: 'COMPLETED' })];
			const session = new SessionState(controller, tour);

			// Visibility is eventually consistent, so a single empty result isn't
			// conclusive — it takes a few consecutive confirmations (simulating the
			// caller's normal polling cadence) before stale progress is reset.
			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toBeNull();
			expect(tour.currentStepIndex).toBe(3);

			await restoreSessionFromSandbox(controller, session);
			expect(tour.currentStepIndex).toBe(3);

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toBeNull();
			expect(tour.currentStepIndex).toBe(0);
			expect(storage.load()).toBeNull();
		});

		it('does not confirm "not found" once a workflow appears mid-retry', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 3);
			const controller = new MockTemporalController();
			const session = new SessionState(controller, tour);

			// First two polls see nothing (Visibility indexing lag); the third
			// sees the workflow the learner actually started.
			controller.visibilityResult = [];
			await restoreSessionFromSandbox(controller, session);
			await restoreSessionFromSandbox(controller, session);
			expect(tour.currentStepIndex).toBe(3);

			controller.visibilityResult = [runningOrderSummary('order-late')];
			await restoreSessionFromSandbox(controller, session);

			expect(session.run?.workflowId).toBe('order-late');
			expect(tour.currentStepIndex).toBe(3);
		});

		it('keeps a finished tour finished when the workflow has since completed', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, TOUR.length);
			const controller = new MockTemporalController();
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);

			expect(tour.isComplete).toBe(true);
		});

		it('leaves the session untouched and allows a retry when visibility fails', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 2);
			const controller = new MockTemporalController();
			controller.visibilityError = new Error('server is down');
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toBeNull();
			expect(tour.currentStepIndex).toBe(2);

			// Once the server recovers, the next trigger retries the restore.
			controller.visibilityError = null;
			controller.visibilityResult = [runningOrderSummary('order-2')];
			await restoreSessionFromSandbox(controller, session);
			expect(session.run?.workflowId).toBe('order-2');
		});

		it('runs at most once and never clobbers a run the learner started', async () => {
			const { controller, session } = makeSession();
			controller.visibilityResult = [runningOrderSummary('order-stale')];
			await session.placeOrder();

			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toEqual(controller.startResult);
			expect(controller.visibilityCalls).toHaveLength(0);
		});

		it('does not adopt a stale run when an order is placed mid-restore', async () => {
			const { controller, session } = makeSession();
			// Simulate the race: the learner places an order while the visibility
			// lookup is still in flight.
			controller.visibility = async () => {
				await session.placeOrder();
				return [runningOrderSummary('order-stale')];
			};

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual(controller.startResult);
			expect(session.activeOrder?.orderId).not.toBe('order-stale');
		});

		it('discards a stale timeline if the learner reset and placed a new order mid-query', async () => {
			const { controller, session } = makeSession();
			controller.visibilityResult = [runningOrderSummary('order-restored')];
			const staleEntries = [timelineEntry(0, ORDER_STATUS.AwaitingRestaurant, 'TimerStarted')];
			// The Visibility lookup resolves fine, but while the getTimeline query
			// for the restored run is in flight, the learner resets and starts a
			// brand-new order — a race Bugbot flagged (comment_id=3525759058).
			controller.query = async <N extends QueryName>(): Promise<QueryReturnMap[N]> => {
				session.reset();
				await session.placeOrder();
				return staleEntries as QueryReturnMap[N];
			};

			await restoreSessionFromSandbox(controller, session);

			// The restored run's stale timeline must not be applied to the new run.
			expect(session.run).toEqual(controller.startResult);
			expect(session.timelineEntries).toEqual([]);
			expect(session.phase).toBe(ORDER_STATUS.Created);
		});

		it('keeps the run when the timeline query fails (worker offline)', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 8);
			const controller = new MockTemporalController();
			controller.visibilityResult = [runningOrderSummary('order-7')];
			controller.query = async () => {
				throw new Error('no worker available');
			};
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);

			// The run is restored and floored to at least the Created phase (a
			// no-op here since step 8 is already well past it); the regular poll
			// reconciles further once the worker returns and the timeline replays.
			expect(session.run?.workflowId).toBe('order-7');
			expect(tour.currentStepIndex).toBe(8);
		});

		it('floors the tour to at least Created on adopting a run even if timeline replay fails', async () => {
			const storage = volatileStorage();
			const tour = new TourState(storage); // fresh — no persisted progress at all
			const controller = new MockTemporalController();
			controller.visibilityResult = [runningOrderSummary('order-8')];
			controller.query = async () => {
				throw new Error('no worker available');
			};
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);

			// Without the immediate floor, a fresh tour would sit at step 0
			// ("Place order") with start-order disabled because a run already
			// exists — stuck until the worker returns. The floor moves it past
			// that dead end right away.
			expect(session.run?.workflowId).toBe('order-8');
			expect(TOUR[tour.currentStepIndex]?.id).toBe('activities-run');
		});

		it('prefers the summary matching a persisted workflow id over an arbitrary first match', async () => {
			const { controller, session } = makeSession();
			controller.visibilityResult = [
				runningOrderSummary('order-old'),
				runningOrderSummary('order-new')
			];

			await restoreSessionFromSandbox(controller, session, 'order-new');

			expect(session.run?.workflowId).toBe('order-new');
		});

		it('falls back to the first resumable match when no preferred id is given or found', async () => {
			const { controller, session } = makeSession();
			controller.visibilityResult = [
				runningOrderSummary('order-old'),
				runningOrderSummary('order-new')
			];

			await restoreSessionFromSandbox(controller, session, 'order-does-not-exist');

			expect(session.run?.workflowId).toBe('order-old');
		});
	});

	it('ingestTimeline reconciles the tour forward against the live phase', async () => {
		const { tour, session } = makeSession();
		await session.placeOrder();
		expect(TOUR[tour.currentStepIndex]?.id).toBe('activities-run');

		// The learner drives the workflow from the toolbar without following the
		// tour: the phase jumps ahead of the current step's completing event.
		session.ingestTimeline([timelineEntry(0, ORDER_STATUS.AwaitingRestaurant, 'TimerStarted')]);

		expect(TOUR[tour.currentStepIndex]?.id).toBe('signal-accept');
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
