import { describe, expect, it } from 'vitest';
import { getProductionConfiguration } from './configuration.ts';

describe('getProductionConfiguration', () => {
	it('defaults the session TTL to 15 minutes when SANDMAN_SESSION_TTL_MS is unset', () => {
		const configuration = getProductionConfiguration({});
		expect(configuration.sessionTtlMs).toBe(900_000);
	});

	it('keeps invite codes disabled unless explicitly required', () => {
		expect(getProductionConfiguration({}).inviteCodeRequired).toBe(false);
		expect(
			getProductionConfiguration({ SANDMAN_INVITE_CODE_REQUIRED: 'true' }).inviteCodeRequired
		).toBe(true);
	});

	it('honors a valid SANDMAN_SESSION_TTL_MS override', () => {
		const configuration = getProductionConfiguration({ SANDMAN_SESSION_TTL_MS: '120000' });
		expect(configuration.sessionTtlMs).toBe(120_000);
	});

	it('falls back to the 15-minute default for a non-positive or non-integer override', () => {
		expect(getProductionConfiguration({ SANDMAN_SESSION_TTL_MS: '0' }).sessionTtlMs).toBe(900_000);
		expect(getProductionConfiguration({ SANDMAN_SESSION_TTL_MS: '-1' }).sessionTtlMs).toBe(900_000);
		expect(getProductionConfiguration({ SANDMAN_SESSION_TTL_MS: 'abc' }).sessionTtlMs).toBe(
			900_000
		);
	});
});
