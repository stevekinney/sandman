/**
 * session-state.svelte.ts — reactive state for the session workbench.
 *
 * Owns the workflow run lifecycle, the live event feed (which also advances
 * the guided tour), the topology flow pulses, and every one-click toolbar
 * action. Actions call the injected `TemporalController` with the canned demo
 * payloads from `session-actions.ts` and surface outcomes through `notify`
 * (wired to the page's toast region).
 */
import type { ControlId, OrderInput, TimelineEntry } from '$lib/contracts/workflow-api';
import type { ProcessLiveness } from '$lib/contracts/sandbox';
import type { WorkflowEvent } from '$lib/contracts/events';
import type { TourState } from '$lib/components/explainer';
import type { TemporalController, WorkflowRun } from './types.ts';
import { isUpdateRejectionError } from './types.ts';
import {
	DEMO_COURIER_LOCATION,
	DEMO_ORDER_DEFAULTS,
	DEMO_UPDATED_ADDRESS,
	buildDemoOrder,
	canUseControl,
	deliveryWorkflowIdFor,
	derivePhase,
	formatMoney,
	isRunActive,
	nowIso,
	type SessionPhase
} from './session-actions.ts';
import { minimumTourStepIndexForPhase } from './session-restore.ts';

/** Severity of a session notification — mirrors Cinder's toast variants. */
export type NotifyVariant = 'info' | 'success' | 'warning' | 'danger';

/** A transient pulse rendered on a topology link while a message is in flight. */
export type FlowPulse = {
	id: number;
	/** Which link the pulse travels: client→server or server→worker. */
	link: 'cs' | 'sw';
};

/** Synthetic event sequences start high so they never collide with timeline indexes. */
const SYNTHETIC_SEQUENCE_START = 10_000;

export class SessionState {
	readonly #controller: TemporalController;
	readonly tour: TourState;

	/** Toast sink — assigned by the page once the toast region is mounted. */
	notify: (message: string, variant: NotifyVariant) => void = () => {};

	run = $state<WorkflowRun | null>(null);
	activeOrder = $state<OrderInput | null>(null);
	timelineEntries = $state<TimelineEntry[]>([]);
	workflowEvents = $state<WorkflowEvent[]>([]);
	workerOnline = $state(true);
	/** True while a worker restart is round-tripping (renders as "replaying"). */
	workerRestarting = $state(false);
	/** Whether the Temporal dev server process is up inside the sandbox. */
	serverOnline = $state(true);
	/** In-flight server lifecycle action, so its button can show progress. */
	serverPending = $state<'stopping' | 'starting' | null>(null);
	/** The control currently in flight, so the toolbar can disable it. */
	pendingControl = $state<ControlId | null>(null);
	/**
	 * Whether the sandbox is usable — false until the page's status poll
	 * reports `ready`, so controls stay gated while provisioning.
	 */
	sandboxUsable = $state(false);
	flows = $state<FlowPulse[]>([]);

	#nextSyntheticSequence = SYNTHETIC_SEQUENCE_START;
	#nextFlowId = 1;
	#lastFedTimelineIndex = -1;

	readonly phase: SessionPhase;
	readonly running: boolean;
	readonly recommendedControl: ControlId | undefined;

	constructor(controller: TemporalController, tour: TourState) {
		this.#controller = controller;
		this.tour = tour;
		this.phase = $derived(derivePhase(this.run !== null, this.timelineEntries));
		this.running = $derived(isRunActive(this.phase));
		this.recommendedControl = $derived(this.tour.currentStep?.control);
	}

	/** Whether a control is usable right now (phase, sandbox, server, worker gates). */
	canDo(control: ControlId): boolean {
		if (this.pendingControl !== null || this.serverPending !== null) return false;
		// The kill-worker control doubles as "restart" while the worker is down.
		if (control === 'kill-worker' && !this.workerOnline) {
			return this.sandboxUsable && this.serverOnline;
		}
		return canUseControl(control, {
			phase: this.phase,
			sandboxUsable: this.sandboxUsable,
			serverOnline: this.serverOnline,
			workerOnline: this.workerOnline
		});
	}

	/** Route a control id (from the toolbar or the tour CTA) to its action. */
	async dispatch(control: ControlId): Promise<void> {
		switch (control) {
			case 'start-order':
				return this.placeOrder();
			case 'accept-restaurant':
				return this.acceptRestaurant();
			case 'reject-restaurant':
				return this.rejectRestaurant();
			case 'food-ready':
				return this.foodReady();
			case 'complete-delivery':
				return this.completeDelivery();
			case 'update-address':
				return this.updateAddress();
			case 'update-location':
				return this.updateLocation();
			case 'apply-promo':
				return this.applyPromo();
			case 'query-status':
				return this.queryStatus();
			case 'query-timeline':
				return this.queryTimeline();
			case 'list-visibility':
				return this.listVisibility();
			case 'add-tip':
				return this.addTip();
			case 'cancel-order':
				return this.cancelOrder();
			case 'kill-worker':
				return this.workerOnline ? this.killWorker() : this.restartWorker();
		}
	}

	/**
	 * Ingest a fresh `getTimeline` poll: replace the entries and replay any new
	 * annotated entries into the event feed (which advances the guided tour).
	 */
	ingestTimeline(entries: TimelineEntry[]): void {
		const run = this.run;
		if (run === null) return;
		this.timelineEntries = entries;
		for (const entry of entries) {
			if (entry.index <= this.#lastFedTimelineIndex || entry.eventType === undefined) continue;
			this.#feedEvent({
				sequence: entry.index,
				type: entry.eventType,
				timestamp: entry.timestamp,
				workflowId: run.workflowId,
				payload: {
					description: entry.description,
					status: entry.status,
					featureId: entry.featureId
				}
			});
			this.#lastFedTimelineIndex = entry.index;
		}
		// The tour must never sit behind the real phase (e.g. restored progress
		// parked on the update step once the order is in delivery, where the
		// validator can never accept). Replayed events advance what they can
		// above; this floors the rest. Forward-only — mirrors reconcileLiveness.
		this.tour.advanceTo(minimumTourStepIndexForPhase(this.phase));
	}

	/**
	 * Reset the demo run, event feed, and tour progress.
	 *
	 * Reset is a client-only action — it never restarts the sandbox — so it must
	 * not fabricate process liveness. `workerOnline`/`serverOnline` keep
	 * reflecting the real backend: a killed worker or stopped server stays shown
	 * as down (and its control stays gated) until the learner actually restarts
	 * it, rather than the topology lying that everything recovered.
	 */
	reset(): void {
		this.run = null;
		this.activeOrder = null;
		this.timelineEntries = [];
		this.workflowEvents = [];
		this.workerRestarting = false;
		this.serverPending = null;
		this.pendingControl = null;
		this.flows = [];
		this.#lastFedTimelineIndex = -1;
		this.#nextSyntheticSequence = SYNTHETIC_SEQUENCE_START;
		this.tour.reset();
	}

	/**
	 * Reconcile process liveness from the backend status poll — the authoritative
	 * source for whether the Temporal server and worker are actually running.
	 *
	 * This keeps the topology honest across cases the client can't observe
	 * locally: a page reload (a fresh `SessionState` would otherwise default both
	 * flags to `true`) and an editor save that hot-restarts the worker through
	 * the files route (which never goes through this client).
	 *
	 * Skipped while an operation is in flight so a poll that raced an in-progress
	 * kill/restart/stop/start can't briefly overwrite the optimistic update and
	 * flicker the topology.
	 */
	reconcileLiveness(liveness: ProcessLiveness): void {
		if (this.pendingControl !== null || this.serverPending !== null || this.workerRestarting) {
			return;
		}
		this.serverOnline = liveness.serverOnline;
		this.workerOnline = liveness.workerOnline;
	}

	// -- actions --------------------------------------------------------------

	async placeOrder(): Promise<void> {
		await this.#perform('start-order', 'cs', async () => {
			const order = buildDemoOrder();
			const run = await this.#controller.start(order);
			this.run = run;
			this.activeOrder = order;
			this.timelineEntries = [];
			this.workflowEvents = [];
			// Starting a workflow does not restart a dead worker, so don't claim
			// one is online: if the worker was killed, `workerOnline` stays false
			// and the topology keeps showing it down until an actual restart.
			this.#lastFedTimelineIndex = -1;
			this.#emitSyntheticEvent('WorkflowExecutionStarted', run.workflowId);
		});
	}

	async acceptRestaurant(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('accept-restaurant', 'cs', () =>
			this.#controller.signal(workflowId, 'restaurantAccepted', {
				estimatedPrepMinutes: DEMO_ORDER_DEFAULTS.estimatedPrepMinutes
			})
		);
	}

	async rejectRestaurant(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('reject-restaurant', 'cs', async () => {
			await this.#controller.signal(workflowId, 'restaurantRejected', {
				reason: DEMO_ORDER_DEFAULTS.rejectReason,
				retryable: false
			});
			this.notify('Rejection signaled — saga compensation refunds the payment.', 'warning');
		});
	}

	async foodReady(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('food-ready', 'cs', () =>
			this.#controller.signal(workflowId, 'foodReady', {})
		);
	}

	async completeDelivery(): Promise<void> {
		const orderId = this.activeOrder?.orderId;
		if (orderId === undefined) return;
		await this.#perform('complete-delivery', 'cs', () =>
			this.#controller.signal(deliveryWorkflowIdFor(orderId), 'deliveryCompleted', {})
		);
	}

	async addTip(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('add-tip', 'cs', async () => {
			await this.#controller.signal(workflowId, 'addTip', {
				amountCents: DEMO_ORDER_DEFAULTS.tipCents
			});
			this.notify(
				`Tip added — ${formatMoney(DEMO_ORDER_DEFAULTS.tipCents)} signaled to the running order.`,
				'success'
			);
		});
	}

	async cancelOrder(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('cancel-order', 'cs', async () => {
			await this.#controller.signal(workflowId, 'cancelOrder', {
				reason: DEMO_ORDER_DEFAULTS.cancelReason
			});
			this.notify('Cancellation signaled — saga compensation refunds the payment.', 'warning');
		});
	}

	async updateAddress(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('update-address', 'cs', async () => {
			try {
				const result = await this.#controller.update(workflowId, 'updateDeliveryAddress', {
					newAddress: DEMO_UPDATED_ADDRESS
				});
				this.notify(
					`Update accepted by the validator — delivering to ${result.effectiveAddress.street}.`,
					'success'
				);
			} catch (error) {
				if (isUpdateRejectionError(error)) {
					// A rejection is the lesson, not a failure: the validator ran
					// synchronously and no history event was written.
					this.notify(
						`Update rejected by the validator (${error.reason}) — no state changed, no history written.`,
						'danger'
					);
					return;
				}
				throw error;
			}
		});
	}

	async updateLocation(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('update-location', 'cs', () =>
			this.#controller.signal(workflowId, 'courierLocationUpdate', DEMO_COURIER_LOCATION)
		);
	}

	async applyPromo(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('apply-promo', 'cs', async () => {
			try {
				const result = await this.#controller.update(workflowId, 'applyPromoCode', {
					code: DEMO_ORDER_DEFAULTS.promoCode
				});
				this.notify(
					`Promo applied — ${result.description}, new total ${formatMoney(result.newTotalCents)}.`,
					'success'
				);
			} catch (error) {
				if (isUpdateRejectionError(error)) {
					this.notify(
						`Promo rejected by the validator (${error.reason}) — no state changed, no history written.`,
						'danger'
					);
					return;
				}
				throw error;
			}
		});
	}

	async queryStatus(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('query-status', 'cs', async () => {
			const snapshot = await this.#controller.query(workflowId, 'getStatus');
			this.#emitSyntheticEvent('QueryCompleted', workflowId);
			this.notify(
				`Snapshot: status ${snapshot.status}, total ${formatMoney(snapshot.totalCents)} — read-only, no history event.`,
				'info'
			);
		});
	}

	async queryTimeline(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('query-timeline', 'cs', async () => {
			const entries = await this.#controller.query(workflowId, 'getTimeline');
			this.ingestTimeline(entries);
			this.#emitSyntheticEvent('QueryCompleted', workflowId);
			this.notify(
				`Timeline snapshot: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — read-only, no history event.`,
				'info'
			);
		});
	}

	async listVisibility(): Promise<void> {
		const order = this.activeOrder;
		if (order === null) return;
		await this.#perform('list-visibility', 'cs', async () => {
			const workflows = await this.#controller.visibility({
				status: this.timelineEntries.at(-1)?.status,
				customerTier: order.customerTier,
				restaurantId: order.restaurantId
			});
			this.#emitSyntheticEvent('QueryCompleted', this.run?.workflowId);
			const count = workflows.length;
			this.notify(
				`Visibility matched ${count} execution${count === 1 ? '' : 's'} for restaurant ${order.restaurantId}.`,
				'info'
			);
		});
	}

	async killWorker(): Promise<void> {
		await this.#perform('kill-worker', 'sw', async () => {
			await this.#controller.killWorker();
			this.workerOnline = false;
			this.#emitSyntheticEvent('WorkerKilled', this.run?.workflowId);
			this.notify(
				'Worker offline. All workflow state is safe in the Temporal server — restart to resume.',
				'warning'
			);
		});
	}

	async restartWorker(): Promise<void> {
		this.workerRestarting = true;
		try {
			await this.#perform('kill-worker', 'sw', async () => {
				await this.#controller.restartWorker();
				this.workerOnline = true;
				this.#emitSyntheticEvent('WorkerRestarted', this.run?.workflowId);
				this.notify(
					'Recovered. History replayed and the workflow resumed exactly where it left off — no state lost.',
					'success'
				);
			});
		} finally {
			this.workerRestarting = false;
		}
	}

	/**
	 * Stop the Temporal dev server. The worker dies with its server connection
	 * (the backend kills it too), but all workflow state is persisted to disk.
	 */
	async stopServer(): Promise<void> {
		if (this.serverPending !== null || this.pendingControl !== null) return;
		this.serverPending = 'stopping';
		this.#pushFlow('cs');
		try {
			await this.#controller.stopServer();
			this.serverOnline = false;
			this.workerOnline = false;
			this.#emitSyntheticEvent('ServerStopped', this.run?.workflowId);
			this.notify(
				'Temporal Server stopped. Nothing progresses while it is down — but workflow state is persisted to disk, so nothing is lost.',
				'warning'
			);
		} catch (error) {
			this.notify(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			this.serverPending = null;
		}
	}

	/** Start the Temporal dev server again and let it recover persisted state. */
	async startServer(): Promise<void> {
		if (this.serverPending !== null || this.pendingControl !== null) return;
		this.serverPending = 'starting';
		this.#pushFlow('cs');
		try {
			await this.#controller.startServer();
			this.serverOnline = true;
			this.workerOnline = true;
			this.#emitSyntheticEvent('ServerStarted', this.run?.workflowId);
			this.notify(
				'Server recovered. In-flight workflows resumed from persisted state — timers, signals, and history intact.',
				'success'
			);
		} catch (error) {
			this.notify(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			this.serverPending = null;
		}
	}

	// -- internals --------------------------------------------------------------

	/** Run an action with in-flight tracking, a flow pulse, and error toasts. */
	async #perform(control: ControlId, link: FlowPulse['link'], action: () => Promise<void>) {
		if (this.pendingControl !== null) return;
		this.pendingControl = control;
		this.#pushFlow(link);
		try {
			await action();
		} catch (error) {
			this.notify(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			this.pendingControl = null;
		}
	}

	#feedEvent(event: WorkflowEvent): void {
		this.tour.feed(event);
		this.workflowEvents = [...this.workflowEvents, event];
	}

	#emitSyntheticEvent(type: string, workflowId?: string): void {
		this.#feedEvent({
			sequence: this.#nextSyntheticSequence++,
			type,
			timestamp: nowIso(),
			workflowId
		});
	}

	#pushFlow(link: FlowPulse['link']): void {
		const pulse: FlowPulse = { id: this.#nextFlowId++, link };
		this.flows = [...this.flows, pulse];
		setTimeout(() => {
			this.flows = this.flows.filter((candidate) => candidate.id !== pulse.id);
		}, 950);
	}
}
