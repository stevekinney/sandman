import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server.ts';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import { getOwnedSandboxStatus } from '$lib/server/database/repository';
import { logError } from '$lib/server/logging';

vi.mock('$lib/server/security/guards', () => ({
	requireOwnedSandbox: vi.fn().mockResolvedValue('session-1')
}));

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	getOwnedSandboxStatus: vi.fn()
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	resolveEntry: vi.fn(() => null)
}));

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn()
}));

function makeEvent() {
	return { params: { id: 'sandbox-1' } } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/sandbox/[id]/status', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('returns a friendly 503 (not a bare Internal Error) when the status query fails', async () => {
		vi.mocked(getOwnedSandboxStatus).mockRejectedValueOnce(new Error('connection refused'));

		await expect(GET(makeEvent())).rejects.toMatchObject({
			status: 503,
			body: { message: 'Could not load sandbox status. Please try again in a moment.' }
		});
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'sandbox.status.failed', sandboxId: 'sandbox-1' })
		);
	});

	it('returns 404 when the sandbox is not found for the session', async () => {
		vi.mocked(getOwnedSandboxStatus).mockResolvedValueOnce(null);

		await expect(GET(makeEvent())).rejects.toMatchObject({ status: 404 });
	});

	it('returns the status payload on success', async () => {
		vi.mocked(getOwnedSandboxStatus).mockResolvedValueOnce({
			sandboxId: 'sandbox-1',
			status: 'ready',
			errorMessage: null,
			expiresAt: new Date('2026-07-06T12:15:00.000Z'),
			updatedAt: new Date('2026-07-06T12:00:00.000Z')
		});

		const response = await GET(makeEvent());
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'ready', processes: null });
		expect(requireOwnedSandbox).toHaveBeenCalledOnce();
	});
});
