/**
 * activity-heartbeat.ts — throttle for the client-side session-activity
 * heartbeat.
 *
 * A leading-edge throttle, not a debounce: the first gesture in a quiet window
 * fires immediately (so the keep-alive POST goes out the moment activity
 * resumes, not only after it stops), and every subsequent gesture within the
 * window is suppressed. It is a plain timestamp comparison and holds no timer,
 * so there is nothing to tear down — the DOM listeners that drive it
 * (`<svelte:window>` / `<svelte:document>` in `+page.svelte`) remove themselves
 * on unmount.
 */

/**
 * Minimum milliseconds between activity-heartbeat POSTs. The session TTL is
 * 15 minutes (900_000 ms); 60s leaves ample margin so a throttled burst of
 * keystrokes can never starve the sliding window.
 */
export const ACTIVITY_HEARTBEAT_THROTTLE_MS = 60_000;

export type ActivityThrottle = {
	/**
	 * Record a gesture attempt. Returns `true` (and opens a fresh throttle
	 * window) when at least `windowMs` has elapsed since the last successful
	 * attempt; returns `false` without resetting the window otherwise.
	 */
	attempt: () => boolean;
	/**
	 * Reopen the window immediately, so the next `attempt()` succeeds. Call this
	 * when a heartbeat POST failed — otherwise a lost/rejected request would
	 * consume the throttle window and swallow every gesture until it elapses,
	 * which near the end of the TTL could end an actively-resumed session.
	 */
	reset: () => void;
};

/**
 * Create a leading-edge throttle that lets at most one `attempt()` return
 * `true` per `windowMs`.
 *
 * @param windowMs - Minimum spacing between successful attempts.
 * @param now - Injectable clock (defaults to `Date.now`) so tests can drive it
 *   with a manual clock instead of sleeping in real time.
 */
export function createActivityThrottle(
	windowMs: number,
	now: () => number = Date.now
): ActivityThrottle {
	let lastSentAt = -Infinity;
	return {
		attempt(): boolean {
			const currentTime = now();
			if (currentTime - lastSentAt < windowMs) return false;
			lastSentAt = currentTime;
			return true;
		},
		reset(): void {
			lastSentAt = -Infinity;
		}
	};
}
