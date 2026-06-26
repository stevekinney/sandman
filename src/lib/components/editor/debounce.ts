/**
 * debounce.ts — generic debounce utility for the Monaco editor save path.
 *
 * Exposes a `cancel()` method so callers can flush pending saves on unmount
 * without leaking timers across test runs.
 */

/** A debounced wrapper around a function. */
export type Debounced<T> = {
	/**
	 * Schedule a call with `arg`. If called again before `delayMs` elapses,
	 * the earlier pending call is cancelled and the timer resets.
	 */
	call: (arg: T) => void;
	/** Cancel any pending invocation without calling the wrapped function. */
	cancel: () => void;
};

/**
 * Creates a debounced wrapper for `fn` with a `delayMs` trailing-edge delay.
 *
 * @param fn - The function to debounce.
 * @param delayMs - Milliseconds to wait after the last `call` before invoking `fn`.
 * @returns A `{ call, cancel }` handle.
 */
export function createDebounce<T>(fn: (arg: T) => void, delayMs: number): Debounced<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	return {
		call(arg: T): void {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				fn(arg);
			}, delayMs);
		},

		cancel(): void {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		}
	};
}
