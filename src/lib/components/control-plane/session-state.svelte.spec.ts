/**
 * session-state.svelte.spec.ts — browser tests for SessionState.
 * Runs in the "client" vitest project because the class uses Svelte runes.
 *
 * Covers the action → controller → event feed → tour progression loop using
 * the in-memory MockTemporalController.
 */
import { describe, expect, it } from 'vitest';
import type { OrderSnapshot, TimelineEntry, WorkflowSummary } from '$lib/contracts/workflow-api';
import { ORDER_STATUS, ORDER_WORKFLOW } from '$lib/contracts/workflow-api';
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
	// Poll with no delay and a small cap so the worker-restart wait never sleeps.
	const session = new SessionState(controller, tour, {
		workerRestartPollMs: 0,
		workerRestartMaxAttempts: 3
	});
	// The page's status poll flips this once the sandbox reports ready.
	session.sandboxUsable = true;
	const notifications: Array<{ message: string; variant: NotifyVariant }> = [];
	session.notify = (message, variant) => notifications.push({ message, variant });
	return { controller, tour, session, notifications };
}

function entry(status: TimelineEntry['status'], index: number): TimelineEntry {
	return {
		timestamp: new Date(index * 1000).toISOString(),
		description: `entry-${index}`,
		status
	};
}

function makeSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
	return {
		status: ORDER_STATUS.Received,
		orderId: 'order-1',
		items: [],
		totalCents: 0,
		paymentAttempts: 1,
		startedAt: new Date(0).toISOString(),
		timeline: [],
		...overrides
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
		// Step 0 (start-workflow) completes on WorkflowExecutionStarted.
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

	it('ingestTimeline feeds only newly inferred events into the event feed', async () => {
		const { session } = makeSession();
		await session.placeOrder();
		const before = session.workflowEvents.length;

		const entries = [
			entry(ORDER_STATUS.Received, 0), // first entry — no previous status, infers nothing
			entry(ORDER_STATUS.Received, 1), // second RECEIVED — ActivityTaskCompleted
			entry(ORDER_STATUS.WaitingForRestaurant, 2) // TimerStarted
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
		session.ingestTimeline([entry(ORDER_STATUS.WaitingForRestaurant, 0)]);
		expect(session.phase).toBe(ORDER_STATUS.WaitingForRestaurant);
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
				payload: {}
			}
		]);
	});

	it('completeDelivery signals the main workflow (no child workflow)', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.completeDelivery();
		expect(controller.signalCalls.at(-1)).toEqual({
			workflowId: controller.startResult.workflowId,
			name: 'deliveryCompleted',
			payload: {}
		});
	});

	it('cancelOrder signals the workflow with the demo cancel reason', async () => {
		const { controller, session, notifications } = makeSession();
		await session.placeOrder();
		await session.cancelOrder();

		expect(controller.signalCalls.at(-1)?.name).toBe('cancelOrder');
		expect((controller.signalCalls.at(-1)?.payload as { reason: string }).reason).toBe(
			'Customer cancelled from the sandbox control plane'
		);
		expect(notifications.at(-1)?.variant).toBe('warning');
	});

	it('queryStatus ingests the snapshot timeline, emits QueryCompleted, and summarizes the snapshot', async () => {
		const { controller, session, notifications } = makeSession();
		const timeline = [
			entry(ORDER_STATUS.Received, 0),
			entry(ORDER_STATUS.Received, 1), // ActivityTaskCompleted
			entry(ORDER_STATUS.WaitingForRestaurant, 2) // TimerStarted
		];
		controller.queryResults.set(
			'getStatus',
			makeSnapshot({ status: ORDER_STATUS.WaitingForRestaurant, totalCents: 2019, timeline })
		);
		await session.placeOrder();
		await session.queryStatus();

		// The snapshot's timeline was ingested — not just the synthetic query event.
		expect(session.timelineEntries).toEqual(timeline);
		expect(session.phase).toBe(ORDER_STATUS.WaitingForRestaurant);
		expect(session.workflowEvents.map((event) => event.type)).toEqual(
			expect.arrayContaining(['ActivityTaskCompleted', 'TimerStarted', 'QueryCompleted'])
		);
		expect(session.workflowEvents.at(-1)?.type).toBe('QueryCompleted');
		expect(notifications.at(-1)?.message).toContain('$20.19');
	});

	it('kill and restart round-trip the worker with recovery events', async () => {
		const { controller, tour, session } = makeSession();
		await session.placeOrder();

		// Walk the tour to the durable-recovery step to verify WorkerRestarted advances it.
		controller.queryResults.set('getStatus', makeSnapshot({ timeline: [] }));
		session.ingestTimeline([
			entry(ORDER_STATUS.Received, 0),
			entry(ORDER_STATUS.Received, 1), // ActivityTaskCompleted
			entry(ORDER_STATUS.WaitingForRestaurant, 2), // TimerStarted
			entry(ORDER_STATUS.Preparing, 3) // WorkflowExecutionSignaled
		]);
		await session.queryStatus(); // QueryCompleted
		expect(TOUR[tour.currentStepIndex]?.id).toBe('durable-recovery');

		await session.killWorker();
		expect(controller.killWorkerCount).toBe(1);
		expect(session.workerOnline).toBe(false);
		expect(session.workflowEvents.at(-1)?.type).toBe('WorkerKilled');
		// While offline, the kill-worker control becomes "restart" and stays usable.
		expect(session.canDo('kill-worker')).toBe(true);

		await session.restartWorker();
		expect(controller.restartWorkerCount).toBe(1);
		// The restart is only reported as recovered once the backend confirms the
		// worker is actually polling again.
		expect(controller.readProcessLivenessCount).toBeGreaterThanOrEqual(1);
		expect(session.workerOnline).toBe(true);
		expect(session.workflowEvents.at(-1)?.type).toBe('WorkerRestarted');
		expect(TOUR[tour.currentStepIndex]?.id).toBe('complete-delivery');
	});

	it('does not claim recovery when a restarted worker never comes back online', async () => {
		const { controller, session, notifications } = makeSession();
		await session.placeOrder();
		await session.killWorker();
		expect(session.workerOnline).toBe(false);

		// The restart request is accepted (204) but the worker stays down — the
		// production failure that leaves the durability demo stuck. The UI must not
		// fabricate a WorkerRestarted event or flip the worker back online.
		controller.processLiveness = { serverOnline: true, workerOnline: false };
		const eventsBefore = session.workflowEvents.length;

		await session.restartWorker();

		expect(controller.restartWorkerCount).toBe(1);
		expect(session.workerOnline).toBe(false);
		expect(session.workerRestarting).toBe(false);
		expect(session.workflowEvents.some((event) => event.type === 'WorkerRestarted')).toBe(false);
		expect(session.workflowEvents.length).toBe(eventsBefore);
		expect(notifications.at(-1)?.variant).toBe('danger');
		// The control stays usable so the user can retry the restart.
		expect(session.canDo('kill-worker')).toBe(true);
	});

	it('does not narrate recovery if the run was reset while the restart was waiting', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.killWorker();
		// The worker will report back online during the restart's poll…
		controller.processLiveness = { serverOnline: true, workerOnline: true };
		// …but the learner clicked Reset mid-wait, clearing the run.
		session.run = null;
		const eventsBefore = session.workflowEvents.length;

		await session.restartWorker();

		// The worker is honestly marked online, but no WorkerRestarted event or
		// success toast is synthesized onto a now-idle session.
		expect(session.workerOnline).toBe(true);
		expect(session.workflowEvents.length).toBe(eventsBefore);
		expect(session.workflowEvents.some((event) => event.type === 'WorkerRestarted')).toBe(false);
	});

	it('invalidates a stale restart when reset runs during its poll', async () => {
		const { controller, session } = makeSession();
		await session.placeOrder();
		await session.killWorker();
		controller.processLiveness = { serverOnline: true, workerOnline: true };

		// Kick off the restart but reset before awaiting it — reset() bumps the
		// restart generation, so the in-flight poll's completion is stale.
		const pending = session.restartWorker();
		session.reset();
		await pending;

		// The stale restart neither narrates a recovery nor clobbers the
		// post-reset session (its finally must not re-touch pendingControl either).
		expect(session.workflowEvents.some((event) => event.type === 'WorkerRestarted')).toBe(false);
		expect(session.run).toBeNull();
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

	it('calls onRunChanged synchronously whenever run changes', async () => {
		const { session } = makeSession();
		const seen: Array<{ workflowId: string } | null> = [];
		session.onRunChanged = (run) => seen.push(run ? { workflowId: run.workflowId } : null);

		await session.placeOrder();
		expect(seen).toEqual([{ workflowId: session.run?.workflowId }]);

		session.reset();
		expect(seen).toEqual([{ workflowId: seen[0]?.workflowId }, null]);
	});

	describe('restoreSessionFromSandbox', () => {
		function runningOrderSummary(
			workflowId: string,
			overrides: Partial<WorkflowSummary> = {}
		): WorkflowSummary {
			return {
				workflowId,
				runId: 'run-restored-1',
				status: 'RUNNING',
				type: ORDER_WORKFLOW,
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
			controller.listWorkflowsResult = [
				runningOrderSummary('other-workflow-1', { type: 'someOtherWorkflow' }),
				runningOrderSummary('order-9')
			];
			controller.queryResults.set(
				'getStatus',
				makeSnapshot({
					status: ORDER_STATUS.WaitingForRestaurant,
					orderId: 'order-9',
					timeline: [
						entry(ORDER_STATUS.Received, 0),
						entry(ORDER_STATUS.Received, 1),
						entry(ORDER_STATUS.WaitingForRestaurant, 2)
					]
				})
			);

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual({ workflowId: 'order-9', runId: 'run-restored-1' });
			// The workflow id is the order id, so the demo order is rebuilt around it.
			expect(session.activeOrder?.orderId).toBe('order-9');
			expect(session.phase).toBe(ORDER_STATUS.WaitingForRestaurant);
			// Replayed history floors the tour to the signal step.
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
			controller.listWorkflowsResult = [
				runningOrderSummary(firstController.startResult.workflowId)
			];
			controller.queryResults.set(
				'getStatus',
				makeSnapshot({ timeline: [entry(ORDER_STATUS.Received, 0)] })
			);
			const tour = new TourState(storage);
			expect(tour.currentStepIndex).toBe(1);
			const session = new SessionState(controller, tour);
			session.sandboxUsable = true;

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual({
				workflowId: firstController.startResult.workflowId,
				runId: 'run-restored-1'
			});
			expect(session.phase).toBe(ORDER_STATUS.Received);
			// No inconsistent half-state: the restored tour step and the restored
			// run agree, and the replayed start event did not double-advance.
			expect(tour.currentStepIndex).toBe(1);
		});

		it('resets stale in-progress tour state once no order workflow is confirmed absent', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 3);
			const controller = new MockTemporalController();
			// An unrelated workflow alone doesn't count — no order workflow of any
			// status exists, which is the only case that should reset progress.
			controller.listWorkflowsResult = [
				runningOrderSummary('other-workflow-1', { type: 'someOtherWorkflow' })
			];
			const session = new SessionState(controller, tour);

			// Listing is eventually consistent, so a single empty result isn't
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

			// First two polls see nothing (listing lag); the third sees the
			// workflow the learner actually started.
			controller.listWorkflowsResult = [];
			await restoreSessionFromSandbox(controller, session);
			await restoreSessionFromSandbox(controller, session);
			expect(tour.currentStepIndex).toBe(3);

			controller.listWorkflowsResult = [runningOrderSummary('order-late')];
			await restoreSessionFromSandbox(controller, session);

			expect(session.run?.workflowId).toBe('order-late');
			expect(tour.currentStepIndex).toBe(3);
		});

		it('does not let an empty result after a listWorkflows error count towards confirmation', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 3);
			const controller = new MockTemporalController();
			const session = new SessionState(controller, tour);

			// Two empty results build a streak of 2 (one short of confirmation).
			controller.listWorkflowsResult = [];
			await restoreSessionFromSandbox(controller, session);
			await restoreSessionFromSandbox(controller, session);
			expect(tour.currentStepIndex).toBe(3);

			// A transient error interrupts the sequence — it isn't an
			// observation and must not let the streak survive to combine with
			// the next empty result.
			controller.listWorkflowsError = new Error('temporal exploded');
			await restoreSessionFromSandbox(controller, session);
			controller.listWorkflowsError = null;

			// Without clearing the streak on error, this would be the "third"
			// confirmed-empty result and would wipe progress.
			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toBeNull();
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

		it('leaves the session untouched and allows a retry when listWorkflows fails', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 2);
			const controller = new MockTemporalController();
			controller.listWorkflowsError = new Error('server is down');
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toBeNull();
			expect(tour.currentStepIndex).toBe(2);

			// Once the server recovers, the next trigger retries the restore.
			controller.listWorkflowsError = null;
			controller.listWorkflowsResult = [runningOrderSummary('order-2')];
			await restoreSessionFromSandbox(controller, session);
			expect(session.run?.workflowId).toBe('order-2');
		});

		it('runs at most once and never clobbers a run the learner started', async () => {
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [runningOrderSummary('order-stale')];
			await session.placeOrder();

			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toEqual(controller.startResult);
			expect(controller.listWorkflowsCount).toBe(0);
		});

		it('does not let a later poll undo a Reset when the learner ordered before restore ever ran', async () => {
			const { controller, session } = makeSession();
			// The learner places an order fast enough that restoreSessionFromSandbox
			// has never actually run yet when it's first called — run is already
			// non-null, so it short-circuits without ever calling listWorkflows.
			await session.placeOrder();
			const orderedWorkflowId = session.run?.workflowId;
			await restoreSessionFromSandbox(controller, session);
			expect(controller.listWorkflowsCount).toBe(0);

			// Reset is client-only — the workflow above keeps running server-side.
			session.reset();
			controller.listWorkflowsResult = [runningOrderSummary(orderedWorkflowId ?? '')];

			// A later poll tick (the same trigger that ran restore the first time)
			// must not resurrect the just-reset run.
			await restoreSessionFromSandbox(controller, session);
			expect(session.run).toBeNull();
			expect(controller.listWorkflowsCount).toBe(0);
		});

		it('does not adopt a stale run when an order is placed mid-restore', async () => {
			const { controller, session } = makeSession();
			// Simulate the race: the learner places an order while the list
			// lookup is still in flight.
			controller.listWorkflows = async () => {
				await session.placeOrder();
				return [runningOrderSummary('order-stale')];
			};

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toEqual(controller.startResult);
			expect(session.activeOrder?.orderId).not.toBe('order-stale');
		});

		it('abandons adopting a run if the learner hits Reset while the list lookup is in flight', async () => {
			const { controller, session } = makeSession();
			// A workflow really is still running server-side (Reset doesn't
			// cancel it) — but the learner reset mid-lookup, and `run` was
			// already null before and after, so a plain `run !== null` recheck
			// wouldn't catch this.
			controller.listWorkflows = async () => {
				session.reset();
				return [runningOrderSummary('order-still-running')];
			};

			await restoreSessionFromSandbox(controller, session);

			expect(session.run).toBeNull();
			expect(session.activeOrder).toBeNull();

			// The abandoned attempt doesn't block a later, uncontested retry —
			// matching what would happen if Reset had simply run first.
			controller.listWorkflows = async () => [runningOrderSummary('order-still-running')];
			await restoreSessionFromSandbox(controller, session);
			expect(session.run?.workflowId).toBe('order-still-running');
		});

		it('discards a stale timeline if the learner reset and placed a new order mid-query', async () => {
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [runningOrderSummary('order-restored')];
			const staleSnapshot = makeSnapshot({
				timeline: [entry(ORDER_STATUS.WaitingForRestaurant, 0)]
			});
			// The list lookup resolves fine, but while the getStatus query for the
			// restored run is in flight, the learner resets and starts a
			// brand-new order.
			controller.query = async () => {
				session.reset();
				await session.placeOrder();
				return staleSnapshot;
			};

			await restoreSessionFromSandbox(controller, session);

			// The restored run's stale timeline must not be applied to the new run.
			expect(session.run).toEqual(controller.startResult);
			expect(session.timelineEntries).toEqual([]);
			expect(session.phase).toBe(ORDER_STATUS.Received);
		});

		it('keeps the run when the timeline query fails (worker offline)', async () => {
			const storage = volatileStorage();
			const tour = restoredTour(storage, 6);
			const controller = new MockTemporalController();
			controller.listWorkflowsResult = [runningOrderSummary('order-7')];
			controller.query = async () => {
				throw new Error('no worker available');
			};
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);

			// The run is restored; the regular poll reconciles further once the
			// worker returns and the timeline replays.
			expect(session.run?.workflowId).toBe('order-7');
			expect(tour.currentStepIndex).toBe(6);
		});

		it('floors the tour to at least activities-run on adopting a run even if timeline replay fails', async () => {
			const storage = volatileStorage();
			const tour = new TourState(storage); // fresh — no persisted progress at all
			const controller = new MockTemporalController();
			controller.listWorkflowsResult = [runningOrderSummary('order-8')];
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
			controller.listWorkflowsResult = [
				runningOrderSummary('order-old'),
				runningOrderSummary('order-new')
			];

			await restoreSessionFromSandbox(controller, session, 'order-new');

			expect(session.run?.workflowId).toBe('order-new');
		});

		it('falls back to the first resumable match when no preferred id is given or found', async () => {
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [
				runningOrderSummary('order-old'),
				runningOrderSummary('order-new')
			];

			await restoreSessionFromSandbox(controller, session, 'order-does-not-exist');

			expect(session.run?.workflowId).toBe('order-old');
		});

		it('excludes a dismissed workflow id, even when it is the only order running', async () => {
			// The learner Reset away from order-stale (still running server-side,
			// since Reset is client-only) and reloaded without placing a new
			// order. It must not be silently re-adopted.
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [runningOrderSummary('order-stale')];

			await restoreSessionFromSandbox(
				controller,
				session,
				undefined,
				['order-stale'] /* dismissedWorkflowIds */
			);

			expect(session.run).toBeNull();
		});

		it('excludes a dismissed workflow id even while adopting a different one', async () => {
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [
				runningOrderSummary('order-dismissed'),
				runningOrderSummary('order-current')
			];

			await restoreSessionFromSandbox(controller, session, undefined, ['order-dismissed']);

			expect(session.run?.workflowId).toBe('order-current');
		});

		it('excludes every id in a multi-entry dismissed set (reset A, order B, reset B too)', async () => {
			const { controller, session } = makeSession();
			// Both order-A and order-B are still running server-side (Reset is
			// client-only) — the learner walked away from both in this sandbox.
			controller.listWorkflowsResult = [
				runningOrderSummary('order-A'),
				runningOrderSummary('order-B')
			];

			await restoreSessionFromSandbox(controller, session, undefined, ['order-A', 'order-B']);

			expect(session.run).toBeNull();
		});

		it('prefers a still-running order over a finished one when both are present', async () => {
			const { controller, session } = makeSession();
			controller.listWorkflowsResult = [
				runningOrderSummary('order-finished', { status: 'COMPLETED' }),
				runningOrderSummary('order-running')
			];

			await restoreSessionFromSandbox(controller, session);

			expect(session.run?.workflowId).toBe('order-running');
		});

		it('preserves and reconciles progress against a finished order instead of wiping it', async () => {
			// The learner completed delivery and reloaded before the final
			// getStatus poll ever recorded WorkflowExecutionCompleted — the
			// workflow is no longer RUNNING, but its history is still real.
			const storage = volatileStorage();
			const tour = restoredTour(storage, 4); // mid-tour, well short of complete
			const controller = new MockTemporalController();
			controller.listWorkflowsResult = [
				runningOrderSummary('order-finished', { status: 'COMPLETED' })
			];
			controller.queryResults.set(
				'getStatus',
				makeSnapshot({
					status: ORDER_STATUS.Delivered,
					timeline: [entry(ORDER_STATUS.Delivered, 0)]
				})
			);
			const session = new SessionState(controller, tour);

			await restoreSessionFromSandbox(controller, session);

			expect(session.run?.workflowId).toBe('order-finished');
			expect(session.phase).toBe(ORDER_STATUS.Delivered);
			// Reconciled against the real (terminal) phase, not reset to step 0.
			expect(tour.currentStepIndex).toBeGreaterThan(0);
		});
	});

	it('ingestTimeline reconciles the tour forward against the live phase', async () => {
		const { tour, session } = makeSession();
		await session.placeOrder();
		expect(TOUR[tour.currentStepIndex]?.id).toBe('activities-run');

		// The learner drives the workflow from the toolbar without following the
		// tour: the phase jumps ahead of the current step's completing event.
		session.ingestTimeline([entry(ORDER_STATUS.WaitingForRestaurant, 0)]);

		expect(TOUR[tour.currentStepIndex]?.id).toBe('signal-accept');
	});

	describe('terminal-state tour deviation', () => {
		/** Walk the tour forward by feeding the events its next steps expect. */
		function walkTour(tour: TourState, eventTypes: string[]): void {
			eventTypes.forEach((type, i) => {
				tour.feed({ sequence: 1000 + i, type, timestamp: new Date(i).toISOString() });
			});
		}

		it('is not stuck while the workflow is still running', async () => {
			const { session } = makeSession();
			expect(session.tourStepStuck).toBe(false); // idle

			await session.placeOrder();
			session.ingestTimeline([entry(ORDER_STATUS.Preparing, 0)]);
			expect(session.tourStepStuck).toBe(false);
		});

		it('cancelling the order to watch saga compensation strands the current step', async () => {
			const { tour, session } = makeSession();
			await session.placeOrder();
			// Walk to the signal-accept step, then deviate: cancel instead of accepting.
			walkTour(tour, ['ActivityTaskCompleted', 'TimerStarted']);
			expect(tour.currentStep?.id).toBe('signal-accept');

			session.ingestTimeline([entry(ORDER_STATUS.Cancelled, 0), entry(ORDER_STATUS.Refunded, 1)]);

			// The workflow is terminal; a restaurant-accepted signal can never arrive.
			expect(session.tourStepStuck).toBe(true);
			// Skipping unsticks the tour one step at a time without faking completion.
			tour.skip();
			expect(tour.currentStep?.id).toBe('query-status');
			expect(tour.completedStepIds).not.toContain('signal-accept');
			// query-status stays reachable post-terminal — queries read closed workflows.
			expect(session.tourStepStuck).toBe(false);
		});

		it('query-driven steps stay live after a terminal phase — queries read closed workflows', async () => {
			const { tour, session } = makeSession();
			await session.placeOrder();
			walkTour(tour, ['ActivityTaskCompleted', 'TimerStarted', 'WorkflowExecutionSignaled']);
			expect(tour.currentStep?.id).toBe('query-status');

			session.ingestTimeline([entry(ORDER_STATUS.Delivered, 0)]);
			expect(session.tourStepStuck).toBe(false);
		});

		it('durable-recovery strands only while the worker is online once the run is over', async () => {
			const { tour, session } = makeSession();
			await session.placeOrder();
			walkTour(tour, [
				'ActivityTaskCompleted',
				'TimerStarted',
				'WorkflowExecutionSignaled',
				'QueryCompleted'
			]);
			expect(tour.currentStep?.id).toBe('durable-recovery');

			// Delivered before the worker was ever killed: kill-worker is gated off
			// for a finished run, so WorkerRestarted can never fire.
			session.ingestTimeline([entry(ORDER_STATUS.Delivered, 0)]);
			expect(session.tourStepStuck).toBe(true);

			// But a worker that is already down can still be restarted, which
			// completes the step even post-terminal — not stuck.
			session.workerOnline = false;
			expect(session.tourStepStuck).toBe(false);
		});

		it('reset() clears the deviation and returns the tour to a startable state', async () => {
			const { tour, session } = makeSession();
			await session.placeOrder();
			walkTour(tour, ['ActivityTaskCompleted', 'TimerStarted']);
			session.ingestTimeline([entry(ORDER_STATUS.Refunded, 0)]);
			expect(session.tourStepStuck).toBe(true);

			session.reset();
			expect(session.tourStepStuck).toBe(false);
			expect(session.phase).toBe('idle');
			expect(tour.currentStepIndex).toBe(0);
			expect(session.canDo('start-order')).toBe(true);
		});
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

		it('emits a recovery event when the poll observes the worker come back late', async () => {
			const { session, notifications } = makeSession();
			await session.placeOrder();
			// Worker was killed and the explicit restart already gave up waiting, so
			// it is shown offline. The next authoritative poll then sees it online.
			session.workerOnline = false;
			const eventsBefore = session.workflowEvents.length;

			session.reconcileLiveness({ serverOnline: true, workerOnline: true });

			expect(session.workerOnline).toBe(true);
			expect(session.workflowEvents.at(-1)?.type).toBe('WorkerRestarted');
			expect(session.workflowEvents.length).toBe(eventsBefore + 1);
			expect(notifications.at(-1)?.variant).toBe('success');
		});

		it('does not synthesize a recovery event when there is no active run', async () => {
			const { session } = makeSession();
			await session.placeOrder();
			await session.killWorker();
			// Reset clears the run but deliberately leaves the worker shown down.
			session.reset();
			expect(session.run).toBeNull();

			// A later poll seeing the worker return must not fabricate a
			// WorkerRestarted event when no workflow is being tracked.
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workflowEvents.some((event) => event.type === 'WorkerRestarted')).toBe(false);
		});

		it('does not emit a recovery event when the server also just came back', () => {
			const { session } = makeSession();
			// Both server and worker were down (server stopped); the poll sees both
			// return. That is a server recovery, not a worker restart, so no
			// WorkerRestarted event should be synthesized here.
			session.serverOnline = false;
			session.workerOnline = false;
			session.reconcileLiveness({ serverOnline: true, workerOnline: true });
			expect(session.workflowEvents.some((event) => event.type === 'WorkerRestarted')).toBe(false);
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
