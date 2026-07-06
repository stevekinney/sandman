/**
 * keyed-mutex.ts — an in-memory async mutex keyed by string.
 *
 * `run(key, task)` queues `task` behind any in-flight task for the same key,
 * so tasks sharing a key execute strictly one at a time in call order. Tasks
 * under different keys run concurrently. A rejected task rejects its own
 * caller but never blocks the tasks queued behind it.
 *
 * The map entry for a key is removed once its queue drains, so idle keys hold
 * no memory. There is no cross-process coordination — this serializes work
 * within a single Node process only.
 *
 * Reentrancy is a deadlock: a task must not call `run` with its own key.
 */

/** Serializes async tasks per key. See module docs. */
export type KeyedMutex = {
	/** Runs `task` once every earlier task queued under `key` has settled. */
	run<T>(key: string, task: () => Promise<T>): Promise<T>;
};

/** Creates an empty {@link KeyedMutex}. */
export function createKeyedMutex(): KeyedMutex {
	// Tail of each key's queue. Stored tails never reject (failures are
	// reflected to the caller via the returned promise instead), so chaining
	// the next task onto a tail cannot trip an unhandled rejection.
	const tails = new Map<string, Promise<void>>();

	return {
		run<T>(key: string, task: () => Promise<T>): Promise<T> {
			const previous = tails.get(key) ?? Promise.resolve();
			const result = previous.then(task);
			const tail = result.then(
				() => undefined,
				() => undefined
			);
			tails.set(key, tail);
			void tail.then(() => {
				// Drop the entry once the queue drains; a newer task replaces the
				// stored tail, in which case this one leaves it alone.
				if (tails.get(key) === tail) tails.delete(key);
			});
			return result;
		}
	};
}
