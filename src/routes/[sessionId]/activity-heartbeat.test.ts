import { describe, expect, it } from 'vitest';
import { ACTIVITY_HEARTBEAT_THROTTLE_MS, createActivityThrottle } from './activity-heartbeat.ts';

describe('createActivityThrottle', () => {
	it('fires on the very first attempt (leading edge)', () => {
		const throttle = createActivityThrottle(60_000, () => 0);
		expect(throttle.attempt()).toBe(true);
	});

	it('collapses a burst of attempts inside the window into exactly one true', () => {
		let clock = 0;
		const throttle = createActivityThrottle(60_000, () => clock);
		expect(throttle.attempt()).toBe(true);
		clock = 1_000;
		expect(throttle.attempt()).toBe(false);
		clock = 59_999;
		expect(throttle.attempt()).toBe(false);
	});

	it('fires again once the full window has elapsed', () => {
		let clock = 0;
		const throttle = createActivityThrottle(60_000, () => clock);
		expect(throttle.attempt()).toBe(true);
		clock = 60_000;
		expect(throttle.attempt()).toBe(true);
	});

	it('uses a real clock by default', () => {
		const throttle = createActivityThrottle(ACTIVITY_HEARTBEAT_THROTTLE_MS);
		expect(throttle.attempt()).toBe(true);
		expect(throttle.attempt()).toBe(false);
	});

	it('reset() reopens the window so the next attempt retries immediately', () => {
		let clock = 0;
		const throttle = createActivityThrottle(60_000, () => clock);
		expect(throttle.attempt()).toBe(true);
		clock = 1_000;
		expect(throttle.attempt()).toBe(false);

		// Simulate a failed heartbeat reopening the window.
		throttle.reset();
		expect(throttle.attempt()).toBe(true);
	});
});
