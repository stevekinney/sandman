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
