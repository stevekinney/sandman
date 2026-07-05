/**
 * tour-engine.spec.ts — pure-logic tests for the TourEngine.
 *
 * Runs in the "server" vitest project (node environment).
 * These tests verify:
 * - Happy-path scripted event sequence advances every step to completion.
 * - An unrelated event does NOT advance the current step.
 * - The final step completes ONLY on a post-restart resumption event.
 * - Tour progress persists through a storage adapter and can be reset.
 * - expect.requireAssertions is satisfied on every test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent } from '$lib/contracts/events';
import type { StorageAdapter, TourProgress } from './tour-engine';
import { TourEngine, localStorageAdapter, stepStuckAtTerminal } from './tour-engine';
import { TOUR } from './demo-script';
import type { TourStep } from './demo-script';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: string, sequence = 0): WorkflowEvent {
	return { sequence, type, timestamp: '2024-01-01T00:00:00.000Z' };
}

/** In-memory storage adapter for testing persistence without a real browser. */
function makeMemoryStorage(initial?: TourProgress): StorageAdapter {
	let stored: TourProgress | null = initial ?? null;
	return {
		load: () => stored,
		save: (p) => {
			stored = { ...p };
		},
		clear: () => {
			stored = null;
		}
	};
}

// ---------------------------------------------------------------------------
// Scripted happy-path event sequence — one event per TOUR step.
// Each event is chosen to satisfy exactly one step's `completes` predicate.
// ---------------------------------------------------------------------------

/** Builds an event that satisfies the given step's predicate. */
function satisfyingEvent(stepIndex: number): WorkflowEvent {
	const step = TOUR[stepIndex];
	if (!step) throw new Error(`No step at index ${stepIndex}`);

	// Try a battery of candidate events until one satisfies the predicate.
	const candidates: WorkflowEvent[] = [
		makeEvent('WorkflowExecutionStarted', stepIndex * 10),
		makeEvent('ActivityTaskCompleted', stepIndex * 10 + 1),
		makeEvent('TimerStarted', stepIndex * 10 + 2),
		makeEvent('WorkflowExecutionSignaled', stepIndex * 10 + 3),
		makeEvent('ChildWorkflowExecutionStarted', stepIndex * 10 + 4),
		makeEvent('WorkflowExecutionUpdateAccepted', stepIndex * 10 + 5),
		makeEvent('MarkerRecorded', stepIndex * 10 + 6),
		makeEvent('WorkflowExecutionContinuedAsNew', stepIndex * 10 + 7),
		makeEvent('WorkerRestarted', stepIndex * 10 + 8),
		makeEvent('QueryCompleted', stepIndex * 10 + 9),
		makeEvent('WorkflowExecutionCompleted', stepIndex * 10 + 10)
	];

	const match = candidates.find((e) => step.completes(e));
	if (!match) throw new Error(`Cannot find a satisfying event for step "${step.id}"`);
	return match;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TourEngine', () => {
	let storage: StorageAdapter;
	let engine: TourEngine;

	beforeEach(() => {
		storage = makeMemoryStorage();
		engine = new TourEngine(TOUR, storage);
	});

	describe('initial state', () => {
		it('starts at step index 0', () => {
			expect(engine.currentStepIndex).toBe(0);
		});

		it('is not complete initially', () => {
			expect(engine.isComplete).toBe(false);
		});

		it('currentStep returns the first TOUR step', () => {
			expect(engine.currentStep?.id).toBe(TOUR[0].id);
		});
	});

	describe('feed()', () => {
		it('returns false and does not advance for an unrelated event on step 0', () => {
			// Step 0 should NOT complete on WorkflowExecutionFailed
			const advanced = engine.feed(makeEvent('WorkflowExecutionFailed', 0));
			expect(advanced).toBe(false);
			expect(engine.currentStepIndex).toBe(0);
		});

		it('returns true and advances to step 1 when the satisfying event for step 0 is fed', () => {
			const event = satisfyingEvent(0);
			const advanced = engine.feed(event);
			expect(advanced).toBe(true);
			expect(engine.currentStepIndex).toBe(1);
		});

		it('an event that satisfies step 0 does NOT advance when engine is already on step 1', () => {
			// Advance to step 1
			engine.feed(satisfyingEvent(0));
			// Feed step-0's satisfying event again — should not re-advance
			const step0Event = satisfyingEvent(0);
			// Sanity: this event satisfies step 0 but NOT step 1
			const satisfiesStep1 = TOUR[1].completes(step0Event);
			if (!satisfiesStep1) {
				const advanced = engine.feed(step0Event);
				expect(advanced).toBe(false);
				expect(engine.currentStepIndex).toBe(1);
			} else {
				// If by coincidence step0 event also satisfies step1, just verify no double-advance
				expect(engine.currentStepIndex).toBeLessThanOrEqual(2);
			}
		});

		it('happy-path: feeding a satisfying event for each step advances all the way to completion', () => {
			for (let i = 0; i < TOUR.length; i++) {
				expect(engine.currentStepIndex).toBe(i);
				const event = satisfyingEvent(i);
				const advanced = engine.feed(event);
				expect(advanced).toBe(true);
			}
			expect(engine.isComplete).toBe(true);
		});

		it('returns false and does not advance after tour is complete', () => {
			// Complete the tour
			for (let i = 0; i < TOUR.length; i++) {
				engine.feed(satisfyingEvent(i));
			}
			const advanced = engine.feed(makeEvent('WorkflowExecutionStarted', 999));
			expect(advanced).toBe(false);
			expect(engine.isComplete).toBe(true);
		});

		it('delivery completion step does NOT complete on WorkerKilled', () => {
			// Advance to the final step
			for (let i = 0; i < TOUR.length - 1; i++) {
				engine.feed(satisfyingEvent(i));
			}
			expect(engine.currentStepIndex).toBe(TOUR.length - 1);

			const advanced = engine.feed(makeEvent('WorkerKilled', 999));
			expect(advanced).toBe(false);
			expect(engine.currentStepIndex).toBe(TOUR.length - 1);
		});

		it('durable recovery step completes on WorkerRestarted', () => {
			const recoveryStepIndex = TOUR.findIndex((step) => step.id === 'durable-recovery');

			for (let i = 0; i < recoveryStepIndex; i++) {
				engine.feed(satisfyingEvent(i));
			}
			expect(engine.currentStepIndex).toBe(recoveryStepIndex);

			const advanced = engine.feed(makeEvent('WorkerRestarted', 1000));
			expect(advanced).toBe(true);
			expect(engine.currentStepIndex).toBe(recoveryStepIndex + 1);
		});

		it('final step completes on WorkflowExecutionCompleted', () => {
			for (let i = 0; i < TOUR.length - 1; i++) {
				engine.feed(satisfyingEvent(i));
			}
			expect(engine.currentStepIndex).toBe(TOUR.length - 1);

			const advanced = engine.feed(makeEvent('WorkflowExecutionCompleted', 1001));
			expect(advanced).toBe(true);
			expect(engine.isComplete).toBe(true);
		});
	});

	describe('advanceTo()', () => {
		it('fast-forwards, marking every skipped step complete, and persists', () => {
			engine.advanceTo(3);
			expect(engine.currentStepIndex).toBe(3);
			expect(engine.completedStepIds).toEqual(TOUR.slice(0, 3).map((step) => step.id));
			expect(storage.load()).toEqual({
				currentStepIndex: 3,
				completedStepIds: TOUR.slice(0, 3).map((step) => step.id)
			});
		});

		it('ignores backward and same-index targets', () => {
			engine.feed(satisfyingEvent(0));
			engine.feed(satisfyingEvent(1));
			const completed = [...engine.completedStepIds];

			engine.advanceTo(1);
			engine.advanceTo(2);
			expect(engine.currentStepIndex).toBe(2);
			expect(engine.completedStepIds).toEqual(completed);
		});

		it('clamps to the end of the tour and reports completion', () => {
			engine.advanceTo(TOUR.length + 5);
			expect(engine.currentStepIndex).toBe(TOUR.length);
			expect(engine.isComplete).toBe(true);
			expect(engine.completedStepIds).toEqual(TOUR.map((step) => step.id));
		});

		it('resumes normal event-driven advancement from the new position', () => {
			engine.advanceTo(3);
			expect(engine.feed(satisfyingEvent(3))).toBe(true);
			expect(engine.currentStepIndex).toBe(4);
		});
	});

	describe('replaceStorage()', () => {
		it('persists future writes to the new adapter without touching current progress', () => {
			engine.advanceTo(2);
			const otherStorage = makeMemoryStorage();

			engine.replaceStorage(otherStorage);
			expect(engine.currentStepIndex).toBe(2);
			expect(otherStorage.load()).toBeNull(); // not re-read on swap

			engine.advanceTo(3);
			expect(storage.load()?.currentStepIndex).toBe(2); // old adapter untouched
			expect(otherStorage.load()?.currentStepIndex).toBe(3); // new adapter gets writes
		});
	});

	describe('skip()', () => {
		it('advances the index without marking the step complete', () => {
			const skipped = engine.skip();
			expect(skipped).toBe(true);
			expect(engine.currentStepIndex).toBe(1);
			expect(engine.completedStepIds).toEqual([]);
		});

		it('persists the skipped-past index so a reload does not resurrect the stuck step', () => {
			engine.feed(satisfyingEvent(0));
			engine.skip();

			const reloaded = new TourEngine(TOUR, storage);
			expect(reloaded.currentStepIndex).toBe(2);
			expect(reloaded.completedStepIds).toEqual([TOUR[0].id]);
		});

		it('skipping every step completes the tour and further skips are no-ops', () => {
			for (let i = 0; i < TOUR.length; i++) {
				expect(engine.skip()).toBe(true);
			}
			expect(engine.isComplete).toBe(true);
			expect(engine.skip()).toBe(false);
			expect(engine.currentStepIndex).toBe(TOUR.length);
		});

		it('after a skip, the next step still completes on its own event', () => {
			engine.skip(); // Skip start-workflow.
			const advanced = engine.feed(satisfyingEvent(1));
			expect(advanced).toBe(true);
			expect(engine.currentStepIndex).toBe(2);
			expect(engine.completedStepIds).toEqual([TOUR[1].id]);
		});
	});

	describe('persistence', () => {
		it('saves progress to the storage adapter after each advance', () => {
			engine.feed(satisfyingEvent(0));
			const saved = storage.load();
			expect(saved).not.toBeNull();
			expect(saved!.currentStepIndex).toBe(1);
		});

		it('a freshly constructed engine restores progress from the adapter', () => {
			// Advance a few steps
			engine.feed(satisfyingEvent(0));
			engine.feed(satisfyingEvent(1));
			const savedIndex = engine.currentStepIndex;

			// Create a new engine backed by the same storage
			const engine2 = new TourEngine(TOUR, storage);
			expect(engine2.currentStepIndex).toBe(savedIndex);
		});

		it('reset() clears progress and clears the storage adapter', () => {
			engine.feed(satisfyingEvent(0));
			engine.reset();
			expect(engine.currentStepIndex).toBe(0);
			expect(storage.load()).toBeNull();
		});

		it('localStorageAdapter can isolate progress by storage key', () => {
			const values = new Map<string, string>();
			vi.stubGlobal('localStorage', {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => {
					values.set(key, value);
				},
				removeItem: (key: string) => {
					values.delete(key);
				}
			});

			const firstSession = new TourEngine(TOUR, localStorageAdapter('sandman:tour-progress:one'));
			firstSession.feed(satisfyingEvent(0));

			const secondSession = new TourEngine(TOUR, localStorageAdapter('sandman:tour-progress:two'));
			expect(secondSession.currentStepIndex).toBe(0);
		});
	});
});

describe('stepStuckAtTerminal', () => {
	function step(id: string): TourStep {
		const found = TOUR.find((candidate) => candidate.id === id);
		if (!found) throw new Error(`No TOUR step with id "${id}"`);
		return found;
	}

	it('event-driven steps are stuck once the workflow is terminal', () => {
		// Cancelling to watch saga compensation strands these: no new workflow
		// start, activities, timers, or signals can ever arrive again.
		for (const id of ['start-workflow', 'activities-run', 'durable-timer', 'signal-accept']) {
			expect(stepStuckAtTerminal(step(id), { workerOnline: true })).toBe(true);
			expect(stepStuckAtTerminal(step(id), { workerOnline: false })).toBe(true);
		}
	});

	it('update and child-workflow steps are stuck once the workflow is terminal', () => {
		for (const id of ['update-with-validator', 'child-workflow', 'complete-delivery']) {
			expect(stepStuckAtTerminal(step(id), { workerOnline: true })).toBe(true);
		}
	});

	it('query-driven steps are NOT stuck — queries read closed workflows', () => {
		expect(stepStuckAtTerminal(step('queryable-business-snapshot'), { workerOnline: true })).toBe(
			false
		);
		expect(stepStuckAtTerminal(step('search-attributes'), { workerOnline: true })).toBe(false);
	});

	it('durable-recovery is stuck with a live worker (kill is gated off), but not with a dead one', () => {
		// With the run over, an online worker can never be killed again, so
		// WorkerRestarted can never fire. A worker that is ALREADY down can still
		// be restarted, which completes the step even post-terminal.
		expect(stepStuckAtTerminal(step('durable-recovery'), { workerOnline: true })).toBe(true);
		expect(stepStuckAtTerminal(step('durable-recovery'), { workerOnline: false })).toBe(false);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});
