import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import {
	incrementRateLimitBucket,
	markSandboxReservationError,
	reserveSandboxSlot
} from '$lib/server/database/repository';
import { getSandboxRegistry } from '$lib/server/sandbox/registry';

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/security/origin', () => ({
	assertSameOrigin: vi.fn()
}));

vi.mock('$lib/server/security/guards', () => ({
	requireAuthenticatedDemoSession: vi.fn().mockResolvedValue({
		id: 'session-1',
		tokenHash: 'token-hash'
	})
}));

vi.mock('$lib/server/database/repository', () => ({
	attachSandboxToReservation: vi.fn().mockResolvedValue(undefined),
	incrementRateLimitBucket: vi.fn().mockResolvedValue(1),
	markSandboxReservationError: vi.fn().mockResolvedValue(undefined),
	reserveSandboxSlot: vi.fn().mockResolvedValue({
		status: 'reserved',
		reservationId: 'reservation-1'
	}),
	updateSandboxStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	deregisterHandle: vi.fn(),
	getSandboxRegistry: vi.fn(() => ({
		client: {
			provision: vi.fn().mockResolvedValue({
				id: 'sandbox-1',
				status: 'Ready',
				host: () => 'localhost'
			}),
			bootstrap: vi.fn().mockResolvedValue({ ready: true }),
			terminate: vi.fn().mockResolvedValue(undefined)
		}
	})),
	registerHandle: vi.fn()
}));

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn(),
	logInfo: vi.fn(),
	logWarning: vi.fn()
}));

function makeEvent(): Parameters<typeof POST>[0] {
	return {
		url: new URL('http://localhost/api/sandbox'),
		request: new Request('http://localhost/api/sandbox', { method: 'POST' }),
		cookies: {
			get: vi.fn()
		}
	} as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/sandbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('DATABASE_URL', 'postgres://example');
		vi.stubEnv('E2B_API_KEY', 'e2b-key');
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'session-secret');
		vi.stubEnv('SANDMAN_SESSION_CREATIONS_PER_TOKEN_PER_HOUR', '5');
		vi.stubEnv('SANDMAN_MAX_ACTIVE_SANDBOXES', '20');
		vi.stubEnv('SANDMAN_MAX_ACTIVE_SANDBOXES_PER_SESSION', '1');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '300000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('does not provision E2B when capacity reservation fails', async () => {
		vi.mocked(reserveSandboxSlot).mockResolvedValueOnce({ status: 'session-limit' });

		await expect(POST(makeEvent())).rejects.toMatchObject({ status: 429 });

		expect(incrementRateLimitBucket).toHaveBeenCalledOnce();
		expect(vi.mocked(getSandboxRegistry)).not.toHaveBeenCalled();
	});

	it('marks the reservation error when E2B provisioning fails', async () => {
		const registry = {
			client: {
				provision: vi.fn().mockRejectedValue(new Error('provision exploded')),
				bootstrap: vi.fn(),
				exec: vi.fn(),
				restartWorker: vi.fn(),
				terminate: vi.fn(),
				writeFile: vi.fn()
			},
			handles: new Map(),
			reaper: {
				register: vi.fn(),
				unregister: vi.fn(),
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReaper: vi.fn()
		};
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);

		await expect(POST(makeEvent())).rejects.toMatchObject({ status: 503 });

		expect(markSandboxReservationError).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: 'reservation-1',
				errorMessage: 'provision exploded'
			})
		);
	});
});
