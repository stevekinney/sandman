/**
 * tour-engine.ts — pure tour-progression engine.
 *
 * Contains no Svelte runes; entirely portable to a Node test environment.
 * The reactive wrapper (tour-state.svelte.ts) imports this and exposes
 * $state-backed properties for component consumption.
 *
 * Advancement rule: the engine evaluates ONLY the current step's `completes`
 * predicate against each incoming event.  Events that arrive before their
 * step becomes current never prematurely advance later steps.
 */

import type { WorkflowEvent } from '$lib/contracts/events';
import type { TourStep } from './demo-script';

// ---------------------------------------------------------------------------
// Progress type
// ---------------------------------------------------------------------------

/** Snapshot of tour progress, stored in the StorageAdapter. */
export type TourProgress = {
	/** Zero-based index of the step currently being worked on. */
	currentStepIndex: number;
	/** IDs of all steps that have been completed, in order. */
	completedStepIds: readonly string[];
};

// ---------------------------------------------------------------------------
// StorageAdapter
// ---------------------------------------------------------------------------

/**
 * Pluggable storage adapter for tour-progress persistence.
 * Pass `localStorageAdapter()` in production and `makeMemoryStorage()` in tests.
 */
export type StorageAdapter = {
	/** Returns the last saved progress, or null if nothing is saved. */
	load(): TourProgress | null;
	/** Persists the given progress snapshot. */
	save(progress: TourProgress): void;
	/** Removes any saved progress. */
	clear(): void;
};

// ---------------------------------------------------------------------------
// localStorage adapter (browser-only; do not call on the server)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sandman:tour-progress';

/**
 * Production StorageAdapter backed by localStorage.
 * Safe to call only in a browser environment.
 */
export function localStorageAdapter(storageKey = STORAGE_KEY): StorageAdapter {
	return {
		load() {
			try {
				const raw = localStorage.getItem(storageKey);
				if (!raw) return null;
				const parsed = JSON.parse(raw) as unknown;
				if (
					typeof parsed === 'object' &&
					parsed !== null &&
					'currentStepIndex' in parsed &&
					'completedStepIds' in parsed &&
					typeof (parsed as Record<string, unknown>).currentStepIndex === 'number' &&
					Array.isArray((parsed as Record<string, unknown>).completedStepIds)
				) {
					return parsed as TourProgress;
				}
				return null;
			} catch {
				return null;
			}
		},
		save(progress) {
			try {
				localStorage.setItem(storageKey, JSON.stringify(progress));
			} catch {
				// Quota exceeded or private-browsing restriction — fail silently.
			}
		},
		clear() {
			try {
				localStorage.removeItem(storageKey);
			} catch {
				// Ignore.
			}
		}
	};
}

// ---------------------------------------------------------------------------
// TourEngine
// ---------------------------------------------------------------------------

/**
 * Pure-logic tour engine.
 *
 * Feed incoming WorkflowEvents via `feed(event)`.  The engine checks ONLY the
 * current step's `completes` predicate.  If it returns true the step is marked
 * complete, the index advances, and progress is persisted to the adapter.
 *
 * Progress can be reset at any time via `reset()`.
 */
export class TourEngine {
	private _steps: readonly TourStep[];
	private _storage: StorageAdapter;
	private _currentStepIndex: number;
	private _completedStepIds: string[];

	constructor(steps: readonly TourStep[], storage: StorageAdapter) {
		this._steps = steps;
		this._storage = storage;

		const saved = storage.load();
		if (saved !== null) {
			this._currentStepIndex = Math.min(saved.currentStepIndex, steps.length);
			this._completedStepIds = [...saved.completedStepIds];
		} else {
			this._currentStepIndex = 0;
			this._completedStepIds = [];
		}
	}

	/** Zero-based index of the active step, or `steps.length` when complete. */
	get currentStepIndex(): number {
		return this._currentStepIndex;
	}

	/** The currently active step, or undefined when the tour is finished. */
	get currentStep(): TourStep | undefined {
		return this._steps[this._currentStepIndex];
	}

	/** True when all steps have been completed. */
	get isComplete(): boolean {
		return this._currentStepIndex >= this._steps.length;
	}

	/** Ordered list of completed step IDs. */
	get completedStepIds(): readonly string[] {
		return this._completedStepIds;
	}

	/**
	 * Feed an incoming WorkflowEvent to the engine.
	 *
	 * @returns `true` if the current step was advanced, `false` otherwise.
	 */
	feed(event: WorkflowEvent): boolean {
		const current = this._steps[this._currentStepIndex];
		if (!current) return false; // Tour already complete.
		if (!current.completes(event)) return false;

		this._completedStepIds.push(current.id);
		this._currentStepIndex++;
		this._storage.save({
			currentStepIndex: this._currentStepIndex,
			completedStepIds: [...this._completedStepIds]
		});
		return true;
	}

	/**
	 * Fast-forward the tour to the given step index, marking every skipped
	 * step complete and persisting the result.
	 *
	 * Used to reconcile restored progress against the real workflow phase
	 * (e.g. an order already in delivery makes the update-validator step
	 * impossible to complete). Forward-only, like `feed()`: backward or
	 * same-index targets are ignored, so progress can never regress this way
	 * either — use `reset()` to start over.
	 */
	advanceTo(index: number): void {
		const target = Math.min(Math.max(index, 0), this._steps.length);
		if (target <= this._currentStepIndex) return;
		for (const step of this._steps.slice(this._currentStepIndex, target)) {
			this._completedStepIds.push(step.id);
		}
		this._currentStepIndex = target;
		this._storage.save({
			currentStepIndex: this._currentStepIndex,
			completedStepIds: [...this._completedStepIds]
		});
	}

	/**
	 * Skip the current step WITHOUT marking it complete — for steps whose
	 * completing event can never arrive anymore (the workflow reached a
	 * terminal phase first). Persists like a normal advance.
	 *
	 * @returns `true` if a step was skipped, `false` when the tour is complete.
	 */
	skip(): boolean {
		if (this._currentStepIndex >= this._steps.length) return false;
		this._currentStepIndex++;
		this._storage.save({
			currentStepIndex: this._currentStepIndex,
			completedStepIds: [...this._completedStepIds]
		});
		return true;
	}

	/**
	 * Swap the adapter future `feed()`/`advanceTo()`/`skip()`/`reset()` calls
	 * persist to, without touching current progress or re-reading the new
	 * adapter.
	 *
	 * Used to defer attaching real persistence until after the first render:
	 * constructing against a throwaway adapter keeps the initial client render
	 * identical to SSR (no localStorage read before hydration), then this
	 * swaps in the real adapter once mounted, client-side only.
	 */
	replaceStorage(storage: StorageAdapter): void {
		this._storage = storage;
	}

	/**
	 * Reset tour progress to the beginning and clear the storage adapter.
	 */
	reset(): void {
		this._currentStepIndex = 0;
		this._completedStepIds = [];
		this._storage.clear();
	}
}

// ---------------------------------------------------------------------------
// Terminal-state stuck detection
// ---------------------------------------------------------------------------

/**
 * Event types the workbench can still emit once the workflow has reached a
 * terminal phase (Delivered/Cancelled/Refunded):
 *
 *  - Queries and Visibility read closed workflows, so `QueryCompleted` events
 *    keep flowing (a dead worker only delays them — it can be restarted).
 *  - Server lifecycle controls are not phase-gated.
 *  - `WorkerRestarted` remains reachable ONLY while the worker is offline;
 *    once the run stops, kill-worker is gated off, so an online worker can
 *    never be killed-and-restarted again.
 */
/** Fixed, valid ISO-8601 timestamp for synthetic probe events (see below). */
const PROBE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function eventTypesProducibleAfterTerminal(workerOnline: boolean): readonly string[] {
	const types = ['QueryCompleted', 'ServerStopped', 'ServerStarted'];
	if (!workerOnline) types.push('WorkerRestarted');
	return types;
}

/**
 * Whether a tour step can never complete now that the workflow is in a
 * terminal phase: none of the event types the workbench can still produce
 * satisfy the step's `completes` predicate. The guided-tour card uses this to
 * offer an inline skip/restart affordance instead of waiting forever.
 */
export function stepStuckAtTerminal(step: TourStep, context: { workerOnline: boolean }): boolean {
	return !eventTypesProducibleAfterTerminal(context.workerOnline).some((type) =>
		// A valid ISO-8601 timestamp so a `completes` predicate that parses it
		// can't throw or misclassify — only `type` actually drives the check.
		step.completes({ sequence: 0, type, timestamp: PROBE_TIMESTAMP })
	);
}
