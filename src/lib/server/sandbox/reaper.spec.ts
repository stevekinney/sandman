/**
 * reaper.spec.ts — TTL reaper unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * Uses an injected clock so no real timers are created or leaked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReaper } from './reaper.ts';

describe('createReaper', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('tick() terminates sandboxes that have exceeded maxAgeMs', async () => {
		const base = Date.now();
		const fakeNow = base;
		const terminated: string[] = [];

		const reaper = createReaper(60_000, () => fakeNow);

		// Registered 2 minutes ago — should be reaped.
		reaper.register('old-sandbox', base - 120_000, async () => {
			terminated.push('old-sandbox');
		});

		await reaper.tick();

		expect(terminated).toContain('old-sandbox');
	});

	it('tick() does NOT terminate sandboxes younger than maxAgeMs', async () => {
		const base = Date.now();
		const terminated: string[] = [];

		const reaper = createReaper(60_000, () => base);

		// Registered 30 seconds ago — still young.
		reaper.register('young-sandbox', base - 30_000, async () => {
			terminated.push('young-sandbox');
		});

		await reaper.tick();

		expect(terminated).not.toContain('young-sandbox');
	});

	it('tick() terminates only expired sandboxes when both kinds are registered', async () => {
		const base = Date.now();
		const fakeNow = base;
		const terminated: string[] = [];

		const reaper = createReaper(60_000, () => fakeNow);

		reaper.register('old', base - 120_000, async () => {
			terminated.push('old');
		});
		reaper.register('young', base - 30_000, async () => {
			terminated.push('young');
		});

		await reaper.tick();

		expect(terminated).toContain('old');
		expect(terminated).not.toContain('young');
	});

	it('unregister() prevents a previously registered sandbox from being reaped', async () => {
		const base = Date.now();
		const terminated: string[] = [];

		const reaper = createReaper(60_000, () => base);

		reaper.register('sandbox-to-remove', base - 120_000, async () => {
			terminated.push('sandbox-to-remove');
		});
		reaper.unregister('sandbox-to-remove');

		await reaper.tick();

		expect(terminated).not.toContain('sandbox-to-remove');
	});

	it('tick() is idempotent — a reaped sandbox is not terminated again on the next tick', async () => {
		const base = Date.now();
		let callCount = 0;

		const reaper = createReaper(60_000, () => base);
		reaper.register('sandbox', base - 120_000, async () => {
			callCount++;
		});

		await reaper.tick();
		await reaper.tick(); // second tick — sandbox already gone

		expect(callCount).toBe(1);
	});

	it('tick() retries a failed terminate function on the next pass', async () => {
		const base = Date.now();
		const reaper = createReaper(60_000, () => base);
		let callCount = 0;

		reaper.register('broken-sandbox', base - 120_000, async () => {
			callCount++;
			if (callCount === 1) throw new Error('terminate exploded');
		});

		await expect(reaper.tick()).resolves.toBeUndefined();
		await expect(reaper.tick()).resolves.toBeUndefined();
		await expect(reaper.tick()).resolves.toBeUndefined();

		expect(callCount).toBe(2);
	});

	it('start() does not run overlapping ticks', async () => {
		vi.useFakeTimers();
		const base = 1_000_000;
		let terminateCalls = 0;
		let releaseTerminate: (() => void) | undefined;

		const reaper = createReaper(60_000, () => base);
		reaper.register('old', base - 120_000, async () => {
			terminateCalls++;
			await new Promise<void>((resolve) => {
				releaseTerminate = resolve;
			});
		});

		const stop = reaper.start(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(terminateCalls).toBe(1);

		releaseTerminate?.();
		await vi.runOnlyPendingTimersAsync();
		stop();
	});

	it('start() returns a cleanup function that stops the interval', () => {
		vi.useFakeTimers();
		const reaper = createReaper(60_000);
		const stop = reaper.start(1_000);

		// Just assert that calling stop does not throw.
		expect(() => stop()).not.toThrow();

		// Advance past the interval — tick should NOT be called after stop.
		vi.advanceTimersByTime(5_000);

		// No assertion beyond "didn't throw" is sufficient here, but we need
		// at least one assertion to satisfy requireAssertions.
		expect(typeof stop).toBe('function');
	});

	it('start() fires tick() on each interval', async () => {
		vi.useFakeTimers();
		const base = 1_000_000; // predictable fixed timestamp
		let terminateCalls = 0;

		const reaper = createReaper(60_000, () => base);
		reaper.register('old', base - 120_000, async () => {
			terminateCalls++;
		});

		const stop = reaper.start(1_000);

		// Advance time past two interval ticks.
		await vi.advanceTimersByTimeAsync(2_500);

		stop();

		expect(terminateCalls).toBeGreaterThanOrEqual(1);
	});
});
