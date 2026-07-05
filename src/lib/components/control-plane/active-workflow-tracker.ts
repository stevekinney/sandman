/**
 * active-workflow-tracker.ts — decides when to persist or clear the sandbox's
 * "last known active workflow id" pointer, without touching storage directly.
 *
 * The pointer disambiguates which run to restore after a reload when
 * Visibility lists more than one resumable order workflow (Reset is
 * client-only and does not cancel the run, so an old one can still be live
 * when the learner starts a new one — see session-restore.ts).
 *
 * `run` reads null both on a fresh, not-yet-restored session AND right after
 * an explicit Reset — those must not be conflated. Clearing on the former
 * would erase the pointer before reload restoration ever gets to read it,
 * silently defeating the disambiguation on the most common path: reload.
 * This tracker uses `resetEpoch` (bumped only by an actual `reset()` call) to
 * tell them apart.
 */

/** The slice of SessionState this tracker reads. Structural on purpose. */
export type TrackedSession = {
	readonly run: { readonly workflowId: string } | null;
	readonly resetEpoch: number;
};

/** What the caller should do to the persisted pointer for this tick. */
export type ActiveWorkflowAction =
	| { kind: 'set'; workflowId: string }
	| { kind: 'clear' }
	| { kind: 'skip' };

/**
 * Tracks one session's `resetEpoch` baseline across calls, so `next()` can
 * distinguish "not yet restored" from "just reset". Construct one instance
 * per page and call `next()` on every relevant reactive tick, passing the
 * current session — a new session instance (e.g. after client-side
 * navigation to a different sandbox) automatically re-baselines.
 */
export class ActiveWorkflowTracker {
	#trackedSession: TrackedSession | undefined;
	#baselineResetEpoch = 0;

	/** What to do with the persisted pointer, given the session's current state. */
	next(session: TrackedSession): ActiveWorkflowAction {
		if (session !== this.#trackedSession) {
			this.#trackedSession = session;
			this.#baselineResetEpoch = session.resetEpoch;
		}

		if (session.run !== null) return { kind: 'set', workflowId: session.run.workflowId };

		if (session.resetEpoch !== this.#baselineResetEpoch) {
			this.#baselineResetEpoch = session.resetEpoch;
			return { kind: 'clear' };
		}

		return { kind: 'skip' };
	}
}
