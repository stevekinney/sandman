import { describe, expect, it } from 'vitest';
import { getSandboxStatusFailureMessage, isSandboxUnusable } from './session-status';

describe('session status helpers', () => {
	it('shows a clear bootstrap failure message for error sandboxes', () => {
		expect(getSandboxStatusFailureMessage('error', 'Temporal server did not become ready')).toBe(
			'Temporal server did not become ready'
		);
		expect(isSandboxUnusable('error')).toBe(true);
	});

	it('shows a clear expired message and marks the sandbox unusable', () => {
		expect(getSandboxStatusFailureMessage('expired', null)).toBe(
			'This sandbox expired and has been terminated. Start a new session to continue.'
		);
		expect(isSandboxUnusable('expired')).toBe(true);
	});

	it('shows a clear terminated message and marks the sandbox unusable', () => {
		expect(getSandboxStatusFailureMessage('terminated', null)).toBe(
			'This sandbox has been terminated. Start a new session to continue.'
		);
		expect(isSandboxUnusable('terminated')).toBe(true);
	});
});
