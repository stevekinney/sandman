/**
 * tour-state.svelte.spec.ts — browser tests for the TourState reactive wrapper.
 * Runs in the "client" vitest project because the class uses Svelte runes.
 */
import { describe, expect, it } from 'vitest';
import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
import { TOUR } from '$lib/content/demo-script';
import { TourState } from './tour-state.svelte.ts';

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

describe('TourState.advanceTo', () => {
	it('advances the current step and marks skipped steps complete', () => {
		const tour = new TourState(volatileStorage());
		tour.advanceTo(3);
		expect(tour.currentStepIndex).toBe(3);
		expect(tour.completedStepIds).toEqual(TOUR.slice(0, 3).map((step) => step.id));
	});

	it('skips the reactive-state reassignment when the target is a no-op', () => {
		const tour = new TourState(volatileStorage());
		tour.advanceTo(2);
		const completedBefore = tour.completedStepIds;

		// Backward and same-index targets are no-ops (see TourEngine.advanceTo);
		// the wrapper must not reassign `_progress` for them, so the exposed
		// array stays referentially identical — no spurious rerender.
		tour.advanceTo(0);
		tour.advanceTo(2);

		expect(tour.currentStepIndex).toBe(2);
		expect(tour.completedStepIds).toBe(completedBefore);
	});
});

describe('TourState.hydrate', () => {
	it('adopts a saved snapshot verbatim, preserving which steps were skipped', () => {
		const tour = new TourState(volatileStorage());
		// This is the exact shape a reload's storage.load() would hand back
		// after a learner used the terminal-state skip escape hatch on step 0.
		tour.hydrate({ currentStepIndex: 2, completedStepIds: [TOUR[1].id] });

		expect(tour.currentStepIndex).toBe(2);
		expect(tour.completedStepIds).toEqual([TOUR[1].id]);
		// Regression: advanceTo would have marked TOUR[0] complete too, putting
		// a checkmark on a step the learner explicitly skipped, not finished.
		expect(tour.completedStepIds).not.toContain(TOUR[0].id);
	});
});

describe('TourState.replaceStorage', () => {
	it('redirects future persistence without re-reading or touching current progress', () => {
		const original = volatileStorage();
		const tour = new TourState(original);
		tour.advanceTo(2);

		const next = volatileStorage();
		tour.replaceStorage(next);

		// Swapping doesn't re-read the new adapter or change in-memory progress.
		expect(tour.currentStepIndex).toBe(2);
		expect(next.load()).toBeNull();

		tour.advanceTo(3);
		expect(original.load()?.currentStepIndex).toBe(2);
		expect(next.load()?.currentStepIndex).toBe(3);
	});
});
