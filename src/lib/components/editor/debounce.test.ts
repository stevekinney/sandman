/**
 * debounce.test.ts — unit tests for the debounce utility.
 * Runs in the "server" vitest project (node environment).
 *
 * Uses vi.useFakeTimers() to assert timer collapse without leaking real timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebounce } from './debounce.ts';

describe('createDebounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls the function after the delay elapses', () => {
		const fn = vi.fn();
		const debounced = createDebounce(fn, 750);

		debounced.call('hello');
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(750);
		expect(fn).toHaveBeenCalledOnce();
		expect(fn).toHaveBeenCalledWith('hello');
	});

	it('collapses a burst of rapid calls into exactly one invocation', () => {
		const fn = vi.fn();
		const debounced = createDebounce(fn, 750);

		debounced.call('a');
		debounced.call('b');
		debounced.call('c');
		debounced.call('d');

		vi.advanceTimersByTime(749);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledOnce();
		// Only the last argument should be passed
		expect(fn).toHaveBeenCalledWith('d');
	});

	it('fires again if called after the delay already elapsed', () => {
		const fn = vi.fn();
		const debounced = createDebounce(fn, 750);

		debounced.call('first');
		vi.advanceTimersByTime(750);
		expect(fn).toHaveBeenCalledOnce();

		debounced.call('second');
		vi.advanceTimersByTime(750);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenLastCalledWith('second');
	});

	it('cancel() prevents the pending call from firing', () => {
		const fn = vi.fn();
		const debounced = createDebounce(fn, 750);

		debounced.call('value');
		debounced.cancel();

		vi.advanceTimersByTime(1000);
		expect(fn).not.toHaveBeenCalled();
	});

	it('cancel() is a no-op when no call is pending', () => {
		const fn = vi.fn();
		const debounced = createDebounce(fn, 750);

		// Should not throw
		debounced.cancel();
		expect(fn).not.toHaveBeenCalled();
	});

	it('per-path debounce: two separate instances do not interfere', () => {
		const fn = vi.fn();
		const debouncedA = createDebounce(fn, 750);
		const debouncedB = createDebounce(fn, 750);

		debouncedA.call('a');
		debouncedB.call('b');

		vi.advanceTimersByTime(750);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
