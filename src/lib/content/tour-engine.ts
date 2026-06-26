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
export function localStorageAdapter(): StorageAdapter {
	return {
		load() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
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
				localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
			} catch {
				// Quota exceeded or private-browsing restriction — fail silently.
			}
		},
		clear() {
			try {
				localStorage.removeItem(STORAGE_KEY);
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
	 * Reset tour progress to the beginning and clear the storage adapter.
	 */
	reset(): void {
		this._currentStepIndex = 0;
		this._completedStepIds = [];
		this._storage.clear();
	}
}
