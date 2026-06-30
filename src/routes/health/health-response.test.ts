import { describe, expect, it } from 'vitest';
import { createHealthResponse } from './health-response';

describe('createHealthResponse', () => {
	it('returns 503 when required configuration is missing', async () => {
		const response = await createHealthResponse({
			databaseUrl: undefined,
			e2bApiKey: undefined,
			e2bTemplateId: undefined,
			demoTokenHash: undefined,
			sessionSecret: undefined,
			sessionTtlMs: 300_000,
			maxActiveSandboxes: 20,
			maxActiveSandboxesPerSession: 1,
			sessionCreationsPerTokenPerHour: 5,
			isProduction: true
		});

		expect(response.status).toBe(503);
	});

	it('returns 200 when configuration and database probe pass', async () => {
		const response = await createHealthResponse(
			{
				databaseUrl: 'postgres://example',
				e2bApiKey: 'e2b',
				e2bTemplateId: 'template',
				demoTokenHash: 'hash',
				sessionSecret: 'secret',
				sessionTtlMs: 300_000,
				maxActiveSandboxes: 20,
				maxActiveSandboxesPerSession: 1,
				sessionCreationsPerTokenPerHour: 5,
				isProduction: true
			},
			{ database: async () => undefined }
		);

		expect(response.status).toBe(200);
	});
});
