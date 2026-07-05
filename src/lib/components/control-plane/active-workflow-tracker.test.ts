/**
 * active-workflow-tracker.test.ts — unit tests for ActiveWorkflowTracker.
 */
import { describe, expect, it } from 'vitest';
import { ActiveWorkflowTracker, type TrackedSession } from './active-workflow-tracker.ts';

/** A mutable stand-in for SessionState — real usage passes the SAME instance across ticks. */
class FakeSession implements TrackedSession {
	run: { workflowId: string } | null = null;
	resetEpoch = 0;
}

describe('ActiveWorkflowTracker', () => {
	it('skips on a fresh, not-yet-restored session instead of clearing', () => {
		const tracker = new ActiveWorkflowTracker();
		const session = new FakeSession();
		// This is the regression this class fixes: a fresh session's `run` is
		// null, indistinguishable from "just reset" by that field alone. A
		// naive "run is null -> clear" effect would wipe the persisted pointer
		// before reload restoration ever reads it.
		expect(tracker.next(session)).toEqual({ kind: 'skip' });
	});

	it('sets the pointer once a run is adopted', () => {
		const tracker = new ActiveWorkflowTracker();
		const session = new FakeSession();
		tracker.next(session);

		session.run = { workflowId: 'order-1' };
		expect(tracker.next(session)).toEqual({ kind: 'set', workflowId: 'order-1' });
	});

	it('clears the pointer only when resetEpoch actually changes', () => {
		const tracker = new ActiveWorkflowTracker();
		const session = new FakeSession();
		session.run = { workflowId: 'order-1' };
		tracker.next(session);

		// Reset: run goes back to null and resetEpoch increments.
		session.run = null;
		session.resetEpoch = 1;
		expect(tracker.next(session)).toEqual({ kind: 'clear' });

		// Subsequent ticks at the same epoch, still no run, don't re-clear.
		expect(tracker.next(session)).toEqual({ kind: 'skip' });
	});

	it('re-baselines when handed a different session instance (e.g. sandbox navigation)', () => {
		const tracker = new ActiveWorkflowTracker();
		const firstSession = new FakeSession();
		firstSession.resetEpoch = 3; // an "old" session, already reset a few times
		tracker.next(firstSession);

		// A brand-new session for a different sandbox naturally starts at
		// resetEpoch 0 again — that must not read as "reset happened" relative
		// to the old session's epoch of 3.
		const secondSession = new FakeSession();
		expect(tracker.next(secondSession)).toEqual({ kind: 'skip' });
	});

	it('handles a reset-then-new-order sequence correctly', () => {
		const tracker = new ActiveWorkflowTracker();
		const session = new FakeSession();
		session.run = { workflowId: 'order-1' };
		tracker.next(session);

		session.run = null;
		session.resetEpoch = 1;
		expect(tracker.next(session)).toEqual({ kind: 'clear' });

		session.run = { workflowId: 'order-2' };
		expect(tracker.next(session)).toEqual({ kind: 'set', workflowId: 'order-2' });
	});
});
