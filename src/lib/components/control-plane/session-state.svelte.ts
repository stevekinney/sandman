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
import { stepStuckAtTerminal } from '$lib/content/tour-engine';
import type { TourState } from '$lib/components/explainer';
import type { TemporalController, WorkflowRun } from './types.ts';
import {
	DEMO_ORDER_DEFAULTS,
	buildDemoOrder,
	canUseControl,
	derivePhase,
	formatMoney,
	inferWorkflowEventType,
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

/**
 * How long to wait for a restarted worker to actually come back online before
 * giving up and telling the user to try again. A restart has to re-bundle the
 * workflow code, reconnect, and replay history, so this allows for a slow cold
 * start while still surfacing a genuinely stuck restart rather than spinning
 * forever. Overridable in tests so they don't sleep.
 */
const DEFAULT_WORKER_RESTART_POLL_MS = 1500;
const DEFAULT_WORKER_RESTART_MAX_ATTEMPTS = 12;

/** Options for tuning {@link SessionState}; only tests override these. */
export type SessionStateOptions = {
	/** Delay between worker-liveness polls after a restart request. */
	workerRestartPollMs?: number;
	/** How many times to poll for the worker before surfacing a failed restart. */
	workerRestartMaxAttempts?: number;
};

/** Resolve after `ms` milliseconds — a cancellable-free sleep for polling. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionState {
	readonly #controller: TemporalController;
	readonly tour: TourState;

	/** Toast sink — assigned by the page once the toast region is mounted. */
	notify: (message: string, variant: NotifyVariant) => void = () => {};
	/**
	 * Invoked synchronously every time `run` changes — assigned by the page to
	 * persist the active workflow id for reload restoration's disambiguation
	 * hint (see session-restore.ts). Deliberately not a `$effect` on `run`:
	 * an effect flushes on the next microtask, which is fine for a live
	 * session but leaves a window where a reload could race ahead of the
	 * write; calling this inline at every mutation site closes that gap.
	 */
	onRunChanged: (run: WorkflowRun | null) => void = () => {};

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
	/**
	 * Bumped by every `reset()`. Lets an in-flight async operation started
	 * before a reset (e.g. reload restoration's Visibility lookup) detect that
	 * the learner reset mid-flight and abandon adopting stale state — even in
	 * the edge case where `run` was already null both before and after, so a
	 * plain `run !== null` recheck wouldn't reveal that a reset happened.
	 */
	resetEpoch = $state(0);

	#nextSyntheticSequence = SYNTHETIC_SEQUENCE_START;
	#nextFlowId = 1;
	#lastFedTimelineIndex = -1;
	// Bumped by every restart and by reset(), so an in-flight restart's poll can
	// tell it has been superseded (a reset, possibly followed by a new order)
	// and must not touch state or narrate a recovery for a run it no longer owns.
	#restartGeneration = 0;
	readonly #workerRestartPollMs: number;
	readonly #workerRestartMaxAttempts: number;

	readonly phase: SessionPhase;
	readonly running: boolean;
	readonly recommendedControl: ControlId | undefined;
	/**
	 * True when the workflow has reached a terminal phase that can never
	 * satisfy the current tour step's `completes` predicate — e.g. the learner
	 * cancelled the order to watch the automatic refund, or the run finished
	 * before the tour caught up. The guided-tour card offers skip/restart.
	 */
	readonly tourStepStuck: boolean;

	constructor(controller: TemporalController, tour: TourState, options: SessionStateOptions = {}) {
		this.#controller = controller;
		this.tour = tour;
		this.#workerRestartPollMs = options.workerRestartPollMs ?? DEFAULT_WORKER_RESTART_POLL_MS;
		this.#workerRestartMaxAttempts =
			options.workerRestartMaxAttempts ?? DEFAULT_WORKER_RESTART_MAX_ATTEMPTS;
		this.phase = $derived(derivePhase(this.run !== null, this.timelineEntries));
		this.running = $derived(isRunActive(this.phase));
		this.recommendedControl = $derived(this.tour.currentStep?.control);
		this.tourStepStuck = $derived.by(() => {
			if (this.phase === 'idle' || this.running) return false;
			const step = this.tour.currentStep;
			if (step === undefined) return false;
			return stepStuckAtTerminal(step, { workerOnline: this.workerOnline });
		});
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
			case 'complete-delivery':
				return this.completeDelivery();
			case 'query-status':
				return this.queryStatus();
			case 'cancel-order':
				return this.cancelOrder();
			case 'kill-worker':
				return this.workerOnline ? this.killWorker() : this.restartWorker();
		}
	}

	/**
	 * Ingest a freshly polled timeline (from the `getStatus` snapshot): replace
	 * the entries and replay any new ones into the event feed (which advances
	 * the guided tour). The Temporal history event behind each entry is inferred
	 * from its status transition — see `inferWorkflowEventType`.
	 */
	ingestTimeline(entries: TimelineEntry[]): void {
		const run = this.run;
		if (run === null) return;
		this.timelineEntries = entries;
		for (let index = 0; index < entries.length; index++) {
			if (index <= this.#lastFedTimelineIndex) continue;
			const entry = entries[index];
			const eventType = inferWorkflowEventType(entries[index - 1]?.status, entry);
			this.#lastFedTimelineIndex = index;
			if (eventType === undefined) continue;
			this.#feedEvent({
				sequence: index,
				type: eventType,
				timestamp: entry.timestamp,
				workflowId: run.workflowId,
				payload: {
					description: entry.description,
					status: entry.status
				}
			});
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
		this.onRunChanged(null);
		this.activeOrder = null;
		this.timelineEntries = [];
		this.workflowEvents = [];
		this.workerRestarting = false;
		this.serverPending = null;
		this.pendingControl = null;
		this.flows = [];
		// Invalidate any in-flight restart poll so its late completion can't act on
		// this now-reset (or freshly-restarted) session.
		this.#restartGeneration++;
		this.#lastFedTimelineIndex = -1;
		this.#nextSyntheticSequence = SYNTHETIC_SEQUENCE_START;
		this.tour.reset();
		this.resetEpoch++;
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
		// A worker that comes back online while the server stayed up — with no
		// explicit restart in flight — is a recovery the poll observed out of band:
		// either a restart that only succeeded after `restartWorker` gave up
		// waiting, or an editor save that hot-restarted the worker through the files
		// route. Narrate it and emit the event so the durable-recovery tour step
		// advances, exactly as an in-band restart would.
		const workerRecovered =
			this.run !== null &&
			this.serverOnline &&
			liveness.serverOnline &&
			!this.workerOnline &&
			liveness.workerOnline;
		this.serverOnline = liveness.serverOnline;
		this.workerOnline = liveness.workerOnline;
		if (workerRecovered) {
			this.#emitSyntheticEvent('WorkerRestarted', this.run?.workflowId);
			this.notify(
				'Recovered. History replayed and the workflow resumed exactly where it left off — no state lost.',
				'success'
			);
		}
	}

	// -- actions --------------------------------------------------------------

	async placeOrder(): Promise<void> {
		await this.#perform('start-order', 'cs', async () => {
			const order = buildDemoOrder();
			const run = await this.#controller.start(order);
			this.run = run;
			this.onRunChanged(run);
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
			this.#controller.signal(workflowId, 'restaurantAccepted', {})
		);
	}

	async completeDelivery(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('complete-delivery', 'cs', () =>
			this.#controller.signal(workflowId, 'deliveryCompleted', {})
		);
	}

	async cancelOrder(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('cancel-order', 'cs', async () => {
			await this.#controller.signal(workflowId, 'cancelOrder', {
				reason: DEMO_ORDER_DEFAULTS.cancelReason
			});
			this.notify(
				'Cancellation signaled — the workflow refunds the payment and finishes.',
				'warning'
			);
		});
	}

	async queryStatus(): Promise<void> {
		const workflowId = this.run?.workflowId;
		if (workflowId === undefined) return;
		await this.#perform('query-status', 'cs', async () => {
			const snapshot = await this.#controller.query(workflowId, 'getStatus');
			this.ingestTimeline(snapshot.timeline);
			this.#emitSyntheticEvent('QueryCompleted', workflowId);
			this.notify(
				`Snapshot: status ${snapshot.status}, total ${formatMoney(snapshot.totalCents)} — read-only, no history event.`,
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

	/**
	 * Request a worker restart, then wait for the worker to actually come back
	 * before claiming recovery.
	 *
	 * The restart route is fire-and-forget (it returns before the worker has
	 * re-bundled and started polling), and a restart can genuinely fail to bring
	 * the worker back. Emitting a synthetic `WorkerRestarted` event optimistically
	 * would make the durability demo *claim* a recovery that never happened — the
	 * worst possible failure for this exact teaching moment — and would resume the
	 * status poll against a dead worker, spamming 502s. So we confirm the
	 * worker is online via the status poll before advancing the tour, and surface
	 * a clear "try again" message if it never recovers.
	 */
	async restartWorker(): Promise<void> {
		if (this.pendingControl !== null || this.serverPending !== null) return;
		const generation = ++this.#restartGeneration;
		this.pendingControl = 'kill-worker';
		this.workerRestarting = true;
		this.#pushFlow('sw');
		try {
			await this.#controller.restartWorker();
			const recovered = await this.#waitForWorkerOnline();
			// If the session was reset (and possibly a new order started) while the
			// poll was running, this restart is stale: another operation now owns the
			// state, so don't touch it or narrate a recovery for a run we lost.
			if (generation !== this.#restartGeneration) return;
			if (recovered) {
				this.workerOnline = true;
				// Only narrate a workflow recovery when there is still a run to recover.
				if (this.run !== null) {
					this.#emitSyntheticEvent('WorkerRestarted', this.run.workflowId);
					this.notify(
						'Recovered. History replayed and the workflow resumed exactly where it left off — no state lost.',
						'success'
					);
				}
			} else {
				// Keep the topology honest: the worker is still down, so its control
				// stays "Restart" and no false recovery event is written.
				this.workerOnline = false;
				this.notify(
					'Restart requested, but the worker has not come back online yet. Give it a moment, then click Restart to try again.',
					'danger'
				);
			}
		} catch (error) {
			if (generation !== this.#restartGeneration) return;
			this.workerOnline = false;
			this.notify(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			// Only release the in-flight flags if they still belong to this restart —
			// a reset (or superseding restart) may already have taken them over.
			if (generation === this.#restartGeneration) {
				this.pendingControl = null;
				this.workerRestarting = false;
			}
		}
	}

	/**
	 * Poll the backend until the worker process is observed online, or the attempt
	 * budget is exhausted. Returns whether the worker actually came back.
	 */
	async #waitForWorkerOnline(): Promise<boolean> {
		for (let attempt = 0; attempt < this.#workerRestartMaxAttempts; attempt++) {
			try {
				const liveness = await this.#controller.readProcessLiveness();
				if (liveness.workerOnline) return true;
			} catch {
				// Status not reachable yet (sandbox mid-restart) — keep waiting.
			}
			if (attempt < this.#workerRestartMaxAttempts - 1) {
				await delay(this.#workerRestartPollMs);
			}
		}
		return false;
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
