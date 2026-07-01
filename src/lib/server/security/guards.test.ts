import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveDemoSession } from '$lib/server/database/repository';
import {
	createSignedSessionCookieValue,
	readSignedSessionCookieValue,
	SESSION_COOKIE_NAME
} from './session.ts';
import { requireAuthenticatedDemoSession } from './guards.ts';

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	getActiveDemoSession: vi.fn().mockResolvedValue({
		id: 'session-1',
		tokenHash: 'token-hash'
	}),
	sandboxBelongsToSession: vi.fn()
}));

function makeEvent(cookieValue: string) {
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

	it('refreshes the signed session cookie after a valid authenticated request', async () => {
		const cookieValue = createSignedSessionCookieValue('session-1', 'session-secret');
		const event = makeEvent(cookieValue);

		await expect(requireAuthenticatedDemoSession(event)).resolves.toEqual({
			id: 'session-1',
			tokenHash: 'token-hash'
		});

		expect(getActiveDemoSession).toHaveBeenCalledOnce();
		expect(event.cookies.set).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({
				httpOnly: true,
				sameSite: 'lax',
				secure: false,
				path: '/',
				maxAge: 300
			})
		);
		const refreshedValue = event.cookies.set.mock.calls[0]?.[1];
		expect(readSignedSessionCookieValue(refreshedValue, 'session-secret')).toBe('session-1');
	});
});
