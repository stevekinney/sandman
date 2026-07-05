/**
 * tour-state.svelte.ts — reactive wrapper around TourEngine.
 *
 * Uses Svelte 5 runes ($state, $derived) to make tour progress observable
 * by components without coupling the pure engine to Svelte's runtime.
 */

import { TourEngine, localStorageAdapter } from '$lib/content/tour-engine';
import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
import { TOUR } from '$lib/content/demo-script';
import type { TourStep } from '$lib/content/demo-script';
import type { WorkflowEvent } from '$lib/contracts/events';

/**
 * Reactive tour state backed by a TourEngine.
 *
 * Use a single shared instance per session (singleton from `createTourState()`).
 * For testing, pass a custom StorageAdapter.
 */
export class TourState {
	private _engine: TourEngine;
	private _progress: TourProgress = $state({ currentStepIndex: 0, completedStepIds: [] });

	constructor(storage: StorageAdapter = localStorageAdapter()) {
		this._engine = new TourEngine(TOUR, storage);
		// Initialise reactive state from any persisted progress.
		this._progress = {
			currentStepIndex: this._engine.currentStepIndex,
			completedStepIds: [...this._engine.completedStepIds]
		};
	}

	/** Zero-based index of the active step, or TOUR.length when complete. */
	get currentStepIndex(): number {
		return this._progress.currentStepIndex;
	}

	/** The currently active step, or undefined when the tour is finished. */
	get currentStep(): TourStep | undefined {
		return TOUR[this._progress.currentStepIndex];
	}

	/** All completed step IDs, in order. */
	get completedStepIds(): readonly string[] {
		return this._progress.completedStepIds;
	}

	/** True when all steps have been completed. */
	get isComplete(): boolean {
		return this._progress.currentStepIndex >= TOUR.length;
	}

	/**
	 * Feed a workflow event to the engine.
	 * Reactive state is updated if the event advances the tour.
	 */
	feed(event: WorkflowEvent): boolean {
		const advanced = this._engine.feed(event);
		if (advanced) {
			this._progress = {
				currentStepIndex: this._engine.currentStepIndex,
				completedStepIds: [...this._engine.completedStepIds]
			};
		}
		return advanced;
	}

	/**
	 * Fast-forward to a later step, marking skipped steps complete — see
	 * `TourEngine.advanceTo`. Backward or same-index targets are ignored.
	 */
	advanceTo(index: number): void {
		const before = this._engine.currentStepIndex;
		this._engine.advanceTo(index);
		// advanceTo is a no-op below/at the current step (see TourEngine.advanceTo);
		// skip the reassignment then so callers that invoke this on every poll
		// (ingestTimeline) don't trigger a reactive update for nothing.
		if (this._engine.currentStepIndex === before) return;
		this._progress = {
			currentStepIndex: this._engine.currentStepIndex,
			completedStepIds: [...this._engine.completedStepIds]
		};
	}

	/**
	 * Skip the current step without marking it complete — for steps whose
	 * completing event can never arrive anymore. Reactive state is updated.
	 */
	skip(): boolean {
		const skipped = this._engine.skip();
		if (skipped) {
			this._progress = {
				currentStepIndex: this._engine.currentStepIndex,
				completedStepIds: [...this._engine.completedStepIds]
			};
		}
		return skipped;
	}

	/**
	 * Swap the adapter future writes persist to — see `TourEngine.replaceStorage`.
	 * Does not re-read or change current progress.
	 */
	replaceStorage(storage: StorageAdapter): void {
		this._engine.replaceStorage(storage);
	}

	/** Reset tour progress and clear storage. Reactive state is updated. */
	reset(): void {
		this._engine.reset();
		this._progress = { currentStepIndex: 0, completedStepIds: [] };
	}
}

/** The singleton TourState instance used by all explainer components. */
let _instance: TourState | undefined;

/**
 * Returns the shared TourState singleton, creating it on first call.
 * Components should call this inside onMount or an effect to avoid SSR issues.
 */
export function getTourState(): TourState {
	if (!_instance) {
		_instance = new TourState();
	}
	return _instance;
}
