import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import {
	decrementRateLimitBucket,
	incrementRateLimitBucket,
	markSandboxReservationError,
	reserveSandboxSlot,
	updateSandboxStatus
} from '$lib/server/database/repository';
import { deregisterHandle, getSandboxRegistry } from '$lib/server/sandbox/registry';
import { logError } from '$lib/server/logging';

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
	decrementRateLimitBucket: vi.fn().mockResolvedValue(0),
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
			killWorker: vi.fn(),
			extendTimeout: vi.fn(),
			terminate: vi.fn().mockResolvedValue(undefined),
			terminateById: vi.fn().mockResolvedValue(undefined)
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
		vi.stubEnv('SANDMAN_SANDBOX_CREATIONS_PER_SESSION_PER_HOUR', '5');
		vi.stubEnv('SANDMAN_MAX_ACTIVE_SANDBOXES', '20');
		vi.stubEnv('SANDMAN_MAX_ACTIVE_SANDBOXES_PER_SESSION', '1');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '900000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('does not provision E2B when capacity reservation fails', async () => {
		vi.mocked(reserveSandboxSlot).mockResolvedValueOnce({ status: 'session-limit' });

		await expect(POST(makeEvent())).rejects.toMatchObject({ status: 429 });

		expect(incrementRateLimitBucket).toHaveBeenCalledOnce();
		expect(decrementRateLimitBucket).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				key: 'sandbox-create:session-1'
			})
		);
		expect(vi.mocked(getSandboxRegistry)).not.toHaveBeenCalled();
	});

	it('returns a friendly 503 (not a bare Internal Error) when capacity reservation throws', async () => {
		vi.mocked(reserveSandboxSlot).mockRejectedValueOnce(new Error('Failed query: ...'));

		await expect(POST(makeEvent())).rejects.toMatchObject({
			status: 503,
			body: { message: 'Could not start the sandbox. Please try again in a moment.' }
		});
		expect(vi.mocked(getSandboxRegistry)).not.toHaveBeenCalled();
		// The rate-limit bucket was already incremented before the reservation
		// query threw — roll it back so a transient DB error doesn't burn the
		// session's hourly quota.
		expect(decrementRateLimitBucket).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ key: 'sandbox-create:session-1' })
		);
	});

	it('does not roll back or mislabel the failure when incrementing the rate limit itself throws', async () => {
		vi.mocked(incrementRateLimitBucket).mockRejectedValueOnce(new Error('Failed query: ...'));

		await expect(POST(makeEvent())).rejects.toMatchObject({ status: 503 });

		// Nothing was ever incremented, so there is nothing to roll back.
		expect(decrementRateLimitBucket).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'sandbox.rate_limit.failed' })
		);
	});

	it('marks the reservation error when E2B provisioning fails', async () => {
		const registry = {
			client: {
				provision: vi.fn().mockRejectedValue(new Error('provision exploded')),
				bootstrap: vi.fn(),
				exec: vi.fn(),
				restartWorker: vi.fn(),
				killWorker: vi.fn(),
				processLiveness: vi.fn(() => null),
				stopServer: vi.fn(),
				startServer: vi.fn(),
				extendTimeout: vi.fn(),
				terminate: vi.fn(),
				terminateById: vi.fn(),
				writeFile: vi.fn()
			},
			handles: new Map(),
			reaper: {
				register: vi.fn(),
				unregister: vi.fn(),
				touch: vi.fn(),
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReaper: vi.fn(),
			reconciler: {
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReconciler: vi.fn()
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
		expect(decrementRateLimitBucket).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				key: 'sandbox-create:session-1'
			})
		);
	});

	it('reports invalid E2B credentials clearly when provisioning is rejected by E2B', async () => {
		const authenticationError = new Error('Invalid API key format');
		authenticationError.name = 'AuthenticationError';
		const registry = {
			client: {
				provision: vi.fn().mockRejectedValue(authenticationError),
				bootstrap: vi.fn(),
				exec: vi.fn(),
				restartWorker: vi.fn(),
				killWorker: vi.fn(),
				processLiveness: vi.fn(() => null),
				stopServer: vi.fn(),
				startServer: vi.fn(),
				extendTimeout: vi.fn(),
				terminate: vi.fn(),
				terminateById: vi.fn(),
				writeFile: vi.fn()
			},
			handles: new Map(),
			reaper: {
				register: vi.fn(),
				unregister: vi.fn(),
				touch: vi.fn(),
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReaper: vi.fn(),
			reconciler: {
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReconciler: vi.fn()
		};
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);

		await expect(POST(makeEvent())).rejects.toMatchObject({
			status: 503,
			body: {
				message: 'E2B_API_KEY is invalid or missing'
			}
		});
	});

	it('starts sandbox expiration from bootstrap readiness instead of reservation time', async () => {
		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		await vi.waitFor(() => {
			expect(updateSandboxStatus).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					sandboxId: 'sandbox-1',
					status: 'ready',
					expiresAt: expect.any(Date)
				})
			);
		});
		const readyCall = vi
			.mocked(updateSandboxStatus)
			.mock.calls.find(([, input]) => input.status === 'ready');
		expect(readyCall).toBeDefined();
		const readyInput = readyCall?.[1];
		expect(readyInput?.expiresAt?.getTime()).toBe(
			readyInput === undefined ? undefined : readyInput.now.getTime() + 900_000
		);
	});

	/** A fully-shaped registry mock (matches the inline mocks used above). */
	function makeReadyRegistryMock() {
		return {
			client: {
				provision: vi
					.fn()
					.mockResolvedValue({ id: 'sandbox-1', status: 'Ready', host: () => 'localhost' }),
				bootstrap: vi.fn().mockResolvedValue({ ready: true }),
				exec: vi.fn(),
				restartWorker: vi.fn(),
				killWorker: vi.fn(),
				processLiveness: vi.fn(() => null),
				stopServer: vi.fn(),
				startServer: vi.fn(),
				extendTimeout: vi.fn(),
				terminate: vi.fn().mockResolvedValue(undefined),
				terminateById: vi.fn().mockResolvedValue(undefined),
				writeFile: vi.fn()
			},
			handles: new Map(),
			reaper: {
				register: vi.fn(),
				unregister: vi.fn(),
				touch: vi.fn(),
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReaper: vi.fn(),
			reconciler: {
				tick: vi.fn(),
				start: vi.fn()
			},
			stopReconciler: vi.fn()
		};
	}

	it('stamps reclaimed:true when a never-ready sandbox is confirmed terminated', async () => {
		// A never-ready sandbox's row is about to leave the active-status set —
		// if reclaimedAt isn't stamped here, the reconciler will later re-select
		// this row (expired, has a VM, reclaimedAt still null) and overwrite its
		// Error status to Expired, corrupting the bootstrap-failure metric.
		const registry = makeReadyRegistryMock();
		registry.client.bootstrap = vi.fn().mockResolvedValue({ ready: false });
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);

		await POST(makeEvent());

		await vi.waitFor(() => {
			expect(updateSandboxStatus).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ sandboxId: 'sandbox-1', status: 'error' })
			);
		});
		const errorCall = vi
			.mocked(updateSandboxStatus)
			.mock.calls.find(([, input]) => input.status === 'error');
		expect(errorCall?.[1].reclaimed).toBe(true);
		expect(registry.client.terminate).toHaveBeenCalled();
	});

	it('stamps reclaimed:false when the never-ready sandbox VM fails to terminate', async () => {
		const registry = makeReadyRegistryMock();
		registry.client.bootstrap = vi.fn().mockResolvedValue({ ready: false });
		registry.client.terminate = vi.fn().mockRejectedValue(new Error('E2B API unreachable'));
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);

		await POST(makeEvent());

		await vi.waitFor(() => {
			expect(updateSandboxStatus).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ sandboxId: 'sandbox-1', status: 'error' })
			);
		});
		const errorCall = vi
			.mocked(updateSandboxStatus)
			.mock.calls.find(([, input]) => input.status === 'error');
		expect(errorCall?.[1].reclaimed).toBe(false);
	});

	it('stamps reclaimed:true when bootstrap throws and the VM is confirmed terminated', async () => {
		const registry = makeReadyRegistryMock();
		registry.client.bootstrap = vi.fn().mockRejectedValue(new Error('bootstrap exploded'));
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);

		await POST(makeEvent());

		await vi.waitFor(() => {
			expect(updateSandboxStatus).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ sandboxId: 'sandbox-1', status: 'error' })
			);
		});
		const errorCall = vi
			.mocked(updateSandboxStatus)
			.mock.calls.find(([, input]) => input.status === 'error');
		expect(errorCall?.[1].reclaimed).toBe(true);
		expect(registry.client.terminate).toHaveBeenCalled();
	});

	it('recovers a ready sandbox by retrying the status write once', async () => {
		const registry = makeReadyRegistryMock();
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);
		// Bootstrapping write ok; first Ready write fails (transient blip); the
		// best-effort retry succeeds.
		vi.mocked(updateSandboxStatus)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('database blip'))
			.mockResolvedValueOnce(undefined);

		const response = await POST(makeEvent());
		expect(response.status).toBe(200);

		await vi.waitFor(() => {
			const readyWrites = vi
				.mocked(updateSandboxStatus)
				.mock.calls.filter(([, input]) => input.status === 'ready');
			// Two Ready attempts: the failed first and the successful retry.
			expect(readyWrites.length).toBe(2);
		});
		expect(registry.client.terminate).not.toHaveBeenCalled();
		expect(vi.mocked(deregisterHandle)).not.toHaveBeenCalled();
	});

	it('never tears down a ready sandbox even if the status write cannot be recovered', async () => {
		const registry = makeReadyRegistryMock();
		vi.mocked(getSandboxRegistry).mockReturnValueOnce(registry);
		// Bootstrapping ok; both the Ready write and its retry fail (DB down).
		vi.mocked(updateSandboxStatus)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('database unavailable'))
			.mockRejectedValueOnce(new Error('database still unavailable'));

		const response = await POST(makeEvent());
		expect(response.status).toBe(200);

		await vi.waitFor(() => {
			expect(vi.mocked(logError)).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'sandbox.bootstrap.bookkeeping_failed' })
			);
		});
		// The working VM must NOT be torn down just because bookkeeping failed.
		expect(registry.client.terminate).not.toHaveBeenCalled();
		expect(vi.mocked(deregisterHandle)).not.toHaveBeenCalled();
	});
});
