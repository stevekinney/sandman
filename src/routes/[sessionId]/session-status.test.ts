import { describe, expect, it } from 'vitest';
import {
	getSandboxStartupProgress,
	getSandboxStatusDisplayLabel,
	getSandboxStatusFailureMessage,
	getSandboxStatusResponseFailureMessage,
	isSandboxStarting,
	isSandboxUnusable
} from './session-status';

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

	it('does not show raw API JSON when the demo session is missing', () => {
		expect(
			getSandboxStatusResponseFailureMessage(401, '{"message":"A valid demo session is required"}')
		).toBe('This sandbox link needs an active session. Start a new sandbox to continue.');
		expect(isSandboxUnusable('authentication-required')).toBe(true);
		expect(getSandboxStatusDisplayLabel('authentication-required')).toBe('Session required');
	});

	it('extracts plain API messages without leaking serialized response bodies', () => {
		expect(getSandboxStatusResponseFailureMessage(503, '{"message":"Database unavailable"}')).toBe(
			'Database unavailable'
		);
		expect(getSandboxStatusResponseFailureMessage(503, 'upstream failed')).toBe('upstream failed');
	});

	it('treats provisioning and bootstrapping as startup states', () => {
		expect(isSandboxStarting('provisioning')).toBe(true);
		expect(isSandboxStarting('bootstrapping')).toBe(true);
		expect(isSandboxStarting('ready')).toBe(false);
		expect(isSandboxStarting('error')).toBe(false);
	});

	it('reports coarse startup progress from the sandbox lifecycle status', () => {
		expect(getSandboxStartupProgress('provisioning')).toMatchObject({
			percent: 34,
			currentStepNumber: 1,
			totalStepCount: 3,
			currentStepLabel: 'Provision sandbox'
		});
		expect(getSandboxStartupProgress('bootstrapping')).toMatchObject({
			percent: 67,
			currentStepNumber: 2,
			totalStepCount: 3,
			currentStepLabel: 'Start Temporal services'
		});
		expect(getSandboxStartupProgress('ready')).toMatchObject({
			percent: 100,
			currentStepNumber: 3,
			totalStepCount: 3,
			currentStepLabel: 'Ready'
		});
	});
});
