import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getActiveDemoSession,
	sandboxBelongsToSession,
	touchActiveDemoSession,
	touchSandboxSession
} from '$lib/server/database/repository';
import { extendHandleTimeout, touchHandle } from '$lib/server/sandbox/registry';
import { logError } from '$lib/server/logging';
import {
	createSignedSessionCookieValue,
	readSignedSessionCookieValue,
	SESSION_COOKIE_NAME
} from './session.ts';
import {
	requireAuthenticatedDemoSession,
	touchSessionActivity,
	touchSessionHeartbeat
} from './guards.ts';

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	getActiveDemoSession: vi.fn().mockResolvedValue({
		id: 'session-1',
		tokenHash: 'token-hash'
	}),
	sandboxBelongsToSession: vi.fn(),
	touchActiveDemoSession: vi.fn().mockResolvedValue(true),
	touchSandboxSession: vi.fn().mockResolvedValue(true)
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	extendHandleTimeout: vi.fn().mockResolvedValue(undefined),
	touchHandle: vi.fn()
}));

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn()
}));

function makeEvent(cookieValue: string | undefined) {
	const cookies = {
		get: vi.fn((name: string) => (name === SESSION_COOKIE_NAME ? cookieValue : undefined)),
		set: vi.fn()
	};
	return {
		url: new URL('http://localhost/api/sandbox/sandbox-1/status'),
		request: new Request('http://localhost/api/sandbox/sandbox-1/status'),
		cookies
	};
}

describe('requireAuthenticatedDemoSession', () => {
	beforeEach(() => {
		vi.stubEnv('DATABASE_URL', 'postgresql://user:password@example.com/sandman');
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'session-secret');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '900000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it('validates the session without sliding its expiry (GETs must not extend the cookie)', async () => {
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(requireAuthenticatedDemoSession(event)).resolves.toEqual({
			id: 'session-1',
			tokenHash: 'token-hash'
		});

		expect(getActiveDemoSession).toHaveBeenCalledOnce();
		// This is the crux of idle-based expiry: a plain authenticated read
		// (as used by passive polling routes) must not refresh the cookie.
		// Only `touchSessionActivity`, called from mutation routes, may do that.
		expect(event.cookies.set).not.toHaveBeenCalled();
	});
});

describe('touchSessionActivity', () => {
	beforeEach(() => {
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'session-secret');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '900000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it('slides the demo session and sandbox session rows, refreshes the cookie, extends E2B, and resets the reaper timer', async () => {
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await touchSessionActivity(event, 'sandbox-1');

		expect(touchActiveDemoSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ sessionId: 'session-1' })
		);
		expect(touchSandboxSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ sandboxId: 'sandbox-1', ttlMs: 900_000 })
		);
		expect(extendHandleTimeout).toHaveBeenCalledWith('sandbox-1', 900_000);
		expect(touchHandle).toHaveBeenCalledWith('sandbox-1');
		expect(vi.mocked(touchSandboxSession).mock.invocationCallOrder[0]).toBeGreaterThan(
			vi.mocked(touchActiveDemoSession).mock.invocationCallOrder[0] ?? 0
		);
		expect(vi.mocked(extendHandleTimeout).mock.invocationCallOrder[0]).toBeGreaterThan(
			vi.mocked(touchHandle).mock.invocationCallOrder[0] ?? 0
		);

		expect(event.cookies.set).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ maxAge: 900 })
		);
		const refreshedValue = event.cookies.set.mock.calls[0]?.[1];
		expect(readSignedSessionCookieValue(refreshedValue, 'session-secret')).toBe('session-1');
	});

	it('does not touch anything when the session cookie is missing or invalid', async () => {
		const event = makeEvent(undefined);

		await touchSessionActivity(event, 'sandbox-1');

		expect(touchActiveDemoSession).not.toHaveBeenCalled();
		expect(touchSandboxSession).not.toHaveBeenCalled();
		expect(extendHandleTimeout).not.toHaveBeenCalled();
		expect(touchHandle).not.toHaveBeenCalled();
		expect(event.cookies.set).not.toHaveBeenCalled();
	});

	it('rejects the mutation and does not slide sandbox expiry when the demo session row is no longer active', async () => {
		vi.mocked(touchActiveDemoSession).mockResolvedValueOnce(false);
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(touchSessionActivity(event, 'sandbox-1')).rejects.toMatchObject({
			status: 401
		});

		expect(touchSandboxSession).not.toHaveBeenCalled();
		expect(event.cookies.set).not.toHaveBeenCalled();
		expect(extendHandleTimeout).not.toHaveBeenCalled();
		expect(touchHandle).not.toHaveBeenCalled();
	});

	it('rejects the mutation and does not refresh the cookie, reaper, or E2B timeout when the sandbox row is already expired', async () => {
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(false);
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(touchSessionActivity(event, 'sandbox-1')).rejects.toMatchObject({
			status: 410
		});

		expect(event.cookies.set).not.toHaveBeenCalled();
		expect(extendHandleTimeout).not.toHaveBeenCalled();
		expect(touchHandle).not.toHaveBeenCalled();
	});

	it('refreshes the cookie and local reaper before attempting the E2B timeout extension', async () => {
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await touchSessionActivity(event, 'sandbox-1');

		expect(event.cookies.set).toHaveBeenCalledOnce();
		expect(touchHandle).toHaveBeenCalledWith('sandbox-1');
		expect(extendHandleTimeout).toHaveBeenCalledWith('sandbox-1', 900_000);
		expect(vi.mocked(extendHandleTimeout).mock.invocationCallOrder[0]).toBeGreaterThan(
			vi.mocked(touchHandle).mock.invocationCallOrder[0] ?? 0
		);
	});

	it('keeps the refreshed cookie and local reaper touch when the E2B timeout extension fails', async () => {
		vi.mocked(extendHandleTimeout).mockRejectedValueOnce(new Error('provider timeout failed'));
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await touchSessionActivity(event, 'sandbox-1');

		expect(event.cookies.set).toHaveBeenCalledOnce();
		expect(touchHandle).toHaveBeenCalledWith('sandbox-1');
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session.touch.failed', sandboxId: 'sandbox-1' })
		);
	});

	it('lets database touch failures fail the mutation because expiry could not be verified', async () => {
		vi.mocked(touchSandboxSession).mockRejectedValueOnce(new Error('database exploded'));
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(touchSessionActivity(event, 'sandbox-1')).rejects.toThrow('database exploded');

		expect(logError).not.toHaveBeenCalled();
		expect(event.cookies.set).not.toHaveBeenCalled();
	});
});

describe('touchSessionHeartbeat', () => {
	beforeEach(() => {
		vi.stubEnv('DATABASE_URL', 'postgresql://user:password@example.com/sandman');
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'session-secret');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '900000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	function validEvent() {
		return makeEvent(createSignedSessionCookieValue('session-1', 'session-secret'));
	}

	it('throws 401 when the session cookie is missing', async () => {
		await expect(touchSessionHeartbeat(makeEvent(undefined), 'sandbox-1')).rejects.toMatchObject({
			status: 401
		});
		expect(touchActiveDemoSession).not.toHaveBeenCalled();
	});

	it('throws 401 when the session cookie signature is invalid', async () => {
		await expect(
			touchSessionHeartbeat(makeEvent('tampered.signature.value'), 'sandbox-1')
		).rejects.toMatchObject({ status: 401 });
		expect(touchActiveDemoSession).not.toHaveBeenCalled();
	});

	it('throws 503 when SANDMAN_SESSION_SECRET is not configured', async () => {
		vi.stubEnv('SANDMAN_SESSION_SECRET', '');
		await expect(touchSessionHeartbeat(validEvent(), 'sandbox-1')).rejects.toMatchObject({
			status: 503
		});
	});

	it('throws 503 when DATABASE_URL is not configured', async () => {
		vi.stubEnv('DATABASE_URL', '');
		await expect(touchSessionHeartbeat(validEvent(), 'sandbox-1')).rejects.toMatchObject({
			status: 503
		});
	});

	it('throws 401 and does not refresh the cookie when the demo session is no longer active', async () => {
		vi.mocked(touchActiveDemoSession).mockResolvedValueOnce(false);
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).rejects.toMatchObject({ status: 401 });

		expect(event.cookies.set).not.toHaveBeenCalled();
		expect(sandboxBelongsToSession).not.toHaveBeenCalled();
	});

	it('throws 503 and logs when the demo-session touch throws, without refreshing the cookie', async () => {
		vi.mocked(touchActiveDemoSession).mockRejectedValueOnce(new Error('connection refused'));
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).rejects.toMatchObject({ status: 503 });

		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session.heartbeat.failed' })
		);
		expect(event.cookies.set).not.toHaveBeenCalled();
	});

	it('slides the demo session and refreshes the cookie with a fresh maxAge when no sandboxId is given', async () => {
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, undefined)).resolves.toEqual({
			sandboxTouched: false
		});

		expect(event.cookies.set).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ maxAge: 900 })
		);
		expect(sandboxBelongsToSession).not.toHaveBeenCalled();
		expect(touchSandboxSession).not.toHaveBeenCalled();
		expect(touchHandle).not.toHaveBeenCalled();
		expect(extendHandleTimeout).not.toHaveBeenCalled();
	});

	it('throws 404 when the sandbox is not owned, but refreshes the cookie first', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(false);
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).rejects.toMatchObject({ status: 404 });

		// The demo session itself is valid — only the sandbox claim is bogus — so
		// the cookie refresh already happened and is intentionally kept.
		expect(event.cookies.set).toHaveBeenCalledOnce();
		expect(touchSandboxSession).not.toHaveBeenCalled();
	});

	it('slides the sandbox and returns sandboxTouched:true when owned and active', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(true);
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(true);
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).resolves.toEqual({
			sandboxTouched: true
		});

		expect(touchSandboxSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ sandboxId: 'sandbox-1', ttlMs: 900_000 })
		);
		expect(touchHandle).toHaveBeenCalledWith('sandbox-1');
		expect(extendHandleTimeout).toHaveBeenCalledWith('sandbox-1', 900_000);
	});

	it('returns sandboxTouched:false without hard-failing when the owned sandbox is already expired', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(true);
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(false);
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).resolves.toEqual({
			sandboxTouched: false
		});
		expect(extendHandleTimeout).not.toHaveBeenCalled();
	});

	it('still returns sandboxTouched:true and logs when the E2B timeout extension fails', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(true);
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(true);
		vi.mocked(extendHandleTimeout).mockRejectedValueOnce(new Error('provider timeout failed'));
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).resolves.toEqual({
			sandboxTouched: true
		});
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session.heartbeat.extend_failed', sandboxId: 'sandbox-1' })
		);
	});

	it('degrades to sandboxTouched:false and logs when the sandbox touch throws, keeping the demo-session slide', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(true);
		vi.mocked(touchSandboxSession).mockRejectedValueOnce(new Error('database exploded'));
		const event = validEvent();

		await expect(touchSessionHeartbeat(event, 'sandbox-1')).resolves.toEqual({
			sandboxTouched: false
		});
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session.heartbeat.sandbox_failed', sandboxId: 'sandbox-1' })
		);
		// The demo-session cookie refresh happened before the sandbox work and is
		// not rolled back by the sandbox-side failure.
		expect(event.cookies.set).toHaveBeenCalledOnce();
	});

	it('refreshes the cookie before performing any sandbox-side work', async () => {
		vi.mocked(sandboxBelongsToSession).mockResolvedValueOnce(true);
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(true);
		const event = validEvent();

		await touchSessionHeartbeat(event, 'sandbox-1');

		expect(event.cookies.set.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(sandboxBelongsToSession).mock.invocationCallOrder[0] ?? Infinity
		);
	});
});
