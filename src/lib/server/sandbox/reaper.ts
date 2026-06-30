/**
 * reaper.ts — session-TTL reaper for E2B sandboxes.
 *
 * Terminates sandboxes that have been alive longer than `maxAgeMs`.
 * The clock is injected so unit tests can control time without real timers.
 */

/** A registered sandbox entry tracked by the reaper. */
type ReaperEntry = {
	id: string;
	createdAt: number;
	terminate: () => Promise<void>;
};

/**
 * A reaper that can check registered sandboxes and terminate the expired ones.
 *
 * Call `tick()` to run a single reap pass. Call `start()` to start an
 * interval-based loop (returns a stop function so timers can be cleaned up).
 */
export type Reaper = {
	/** Register a sandbox to be reaped when it exceeds the configured max age. */
	register(id: string, createdAt: number, terminate: () => Promise<void>): void;
	/** Remove a sandbox from TTL tracking (e.g. after explicit terminate). */
	unregister(id: string): void;
	/** Perform a single reap pass — exposed for deterministic testing. */
	tick(): Promise<void>;
	/**
	 * Start a recurring reap loop using real timers.
	 * @returns a cleanup function that stops the loop.
	 */
	start(intervalMs: number): () => void;
};

/**
 * Creates a `Reaper` that uses an injected clock for deterministic time control.
 *
 * @param maxAgeMs - Maximum sandbox lifetime in milliseconds.
 * @param now - Injected clock function returning the current Unix timestamp in ms.
 */
export function createReaper(maxAgeMs: number, now: () => number = Date.now): Reaper {
	const entries = new Map<string, ReaperEntry>();

	async function tick(): Promise<void> {
		const cutoff = now() - maxAgeMs;
		const expired = [...entries.values()].filter((e) => e.createdAt <= cutoff);

		await Promise.all(
			expired.map(async (e) => {
				entries.delete(e.id);
				try {
					await e.terminate();
				} catch {
					// Sandbox may already be gone; swallow the error.
				}
			})
		);
	}

	return {
		register(id, createdAt, terminate) {
			entries.set(id, { id, createdAt, terminate });
		},

		unregister(id) {
			entries.delete(id);
		},

		tick,

		start(intervalMs) {
			const handle = setInterval(() => {
				// Fire-and-forget; errors are swallowed in tick().
				void tick();
			}, intervalMs);
			handle.unref?.();
			return () => clearInterval(handle);
		}
	};
}
