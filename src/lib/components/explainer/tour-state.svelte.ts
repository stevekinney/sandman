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
