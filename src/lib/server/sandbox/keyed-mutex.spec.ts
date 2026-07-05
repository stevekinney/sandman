/**
 * keyed-mutex.spec.ts — unit tests for the per-key async mutex.
 */

import { describe, it, expect } from 'vitest';
import { createKeyedMutex } from './keyed-mutex.ts';

/** A promise with its resolver exposed, for hand-driven task completion. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('createKeyedMutex()', () => {
	it('serializes tasks under the same key in call order', async () => {
		const mutex = createKeyedMutex();
		const events: string[] = [];
		const firstGate = deferred();

		const first = mutex.run('a', async () => {
			events.push('first:start');
			await firstGate.promise;
			events.push('first:end');
		});
		const second = mutex.run('a', async () => {
			events.push('second:start');
		});

		// The second task must not start while the first holds the lock.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(['first:start']);

		firstGate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(['first:start', 'first:end', 'second:start']);
	});

	it('runs tasks under different keys concurrently', async () => {
		const mutex = createKeyedMutex();
		const events: string[] = [];
		const gate = deferred();

		const blocked = mutex.run('a', async () => {
			await gate.promise;
			events.push('a');
		});
		const independent = mutex.run('b', async () => {
			events.push('b');
		});

		await independent;
		expect(events).toEqual(['b']); // 'b' finished while 'a' still held its lock

		gate.resolve();
		await blocked;
		expect(events).toEqual(['b', 'a']);
	});

	it('returns the task result to the caller', async () => {
		const mutex = createKeyedMutex();
		await expect(mutex.run('a', async () => 42)).resolves.toBe(42);
	});

	it('rejects the caller of a failing task without blocking the next task', async () => {
		const mutex = createKeyedMutex();

		const failing = mutex.run('a', async () => {
			throw new Error('boom');
		});
		const following = mutex.run('a', async () => 'ran');

		await expect(failing).rejects.toThrow('boom');
		await expect(following).resolves.toBe('ran');
	});
});
