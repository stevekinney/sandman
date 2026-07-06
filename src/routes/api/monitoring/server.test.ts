import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server.ts';
import { requireAuthenticatedDemoSession } from '$lib/server/security/guards';
import { getMonitoringSnapshot } from '$lib/server/database/repository';
import { logError } from '$lib/server/logging';

vi.mock('$lib/server/security/guards', () => ({
	requireAuthenticatedDemoSession: vi.fn().mockResolvedValue({ id: 'session-1', tokenHash: 'hash' })
}));

vi.mock('$lib/server/configuration', () => ({
	getProductionConfiguration: vi.fn(() => ({ maxActiveSandboxes: 20 }))
}));

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	getMonitoringSnapshot: vi.fn()
}));

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn()
}));

function makeEvent() {
	return {} as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/monitoring', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('returns a friendly 503 (not a bare Internal Error) when the snapshot query fails', async () => {
		vi.mocked(getMonitoringSnapshot).mockRejectedValueOnce(new Error('connection refused'));

		await expect(GET(makeEvent())).rejects.toMatchObject({
			status: 503,
			body: { message: 'Could not load monitoring data. Please try again in a moment.' }
		});
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'monitoring.snapshot.failed' })
		);
	});

	it('returns the monitoring snapshot on success', async () => {
		vi.mocked(getMonitoringSnapshot).mockResolvedValueOnce({
			activeSandboxes: 3,
			globalLimit: 20,
			recentBootstrapFailures: 0,
			expiredSandboxes: 5
		});

		const response = await GET(makeEvent());
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ activeSandboxes: 3, globalLimit: 20 });
		expect(requireAuthenticatedDemoSession).toHaveBeenCalledOnce();
	});
});
