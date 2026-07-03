import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getActiveDemoSession,
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
import { requireAuthenticatedDemoSession, touchSessionActivity } from './guards.ts';

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
	} as unknown as Parameters<typeof requireAuthenticatedDemoSession>[0] & {
		cookies: typeof cookies;
	};
}

describe('requireAuthenticatedDemoSession', () => {
	beforeEach(() => {
		vi.stubEnv('DATABASE_URL', 'postgresql://user:password@example.com/sandman');
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'session-secret');
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '300000');
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
		vi.stubEnv('SANDMAN_SESSION_TTL_MS', '300000');
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
			expect.objectContaining({ sandboxId: 'sandbox-1', ttlMs: 300_000 })
		);
		expect(extendHandleTimeout).toHaveBeenCalledWith('sandbox-1', 300_000);
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
			expect.objectContaining({ maxAge: 300 })
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

	it('does not slide sandbox expiry when the demo session row is no longer active', async () => {
		vi.mocked(touchActiveDemoSession).mockResolvedValueOnce(false);
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await touchSessionActivity(event, 'sandbox-1');

		expect(touchSandboxSession).not.toHaveBeenCalled();
		expect(event.cookies.set).not.toHaveBeenCalled();
		expect(extendHandleTimeout).not.toHaveBeenCalled();
		expect(touchHandle).not.toHaveBeenCalled();
	});

	it('does not refresh the cookie, reaper, or E2B timeout when the sandbox row is already expired', async () => {
		vi.mocked(touchSandboxSession).mockResolvedValueOnce(false);
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await touchSessionActivity(event, 'sandbox-1');

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
		expect(extendHandleTimeout).toHaveBeenCalledWith('sandbox-1', 300_000);
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

	it('logs and swallows failures instead of throwing (a touch failure must not fail the request)', async () => {
		vi.mocked(touchSandboxSession).mockRejectedValueOnce(new Error('database exploded'));
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(touchSessionActivity(event, 'sandbox-1')).resolves.toBeUndefined();

		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session.touch.failed', sandboxId: 'sandbox-1' })
		);
		expect(event.cookies.set).not.toHaveBeenCalled();
	});
});
