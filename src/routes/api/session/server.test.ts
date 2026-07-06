import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './+server.ts';
import { hashDemoToken, SESSION_COOKIE_NAME } from '$lib/server/security/session';
import { createDemoSession } from '$lib/server/database/repository';

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	createDemoSession: vi.fn().mockResolvedValue(undefined)
}));

function makeEvent(body: unknown, origin = 'http://localhost') {
	const event = {
		url: new URL('http://localhost/api/session'),
		request: new Request('http://localhost/api/session', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		cookies: {
			set: vi.fn()
		}
	};
	return event as Parameters<typeof POST>[0] & typeof event;
}

describe('POST /api/session', () => {
	beforeEach(() => {
		vi.stubEnv('DATABASE_URL', 'postgresql://user:password@example.com/sandman');
		vi.stubEnv('SANDMAN_SESSION_SECRET', 'secret');
		vi.stubEnv('SANDMAN_DEMO_TOKEN_SHA256', hashDemoToken('demo-token'));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it('rejects invalid invite codes', async () => {
		await expect(
			POST(makeEvent({ token: 'wrong-token', email: 'test@example.com' }))
		).rejects.toMatchObject({
			status: 401
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects mismatched origins', async () => {
		await expect(
			POST(makeEvent({ token: 'demo-token', email: 'test@example.com' }, 'https://evil.example'))
		).rejects.toMatchObject({
			status: 403
		});
	});

	it('rejects requests without an email', async () => {
		await expect(POST(makeEvent({ token: 'demo-token' }))).rejects.toMatchObject({
			status: 400,
			body: { message: 'Request body must include "email"' }
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects non-string or blank invite codes', async () => {
		for (const token of [123, '   ']) {
			await expect(POST(makeEvent({ token, email: 'test@example.com' }))).rejects.toMatchObject({
				status: 400,
				body: { message: 'Request body must include "token"' }
			});
		}
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects non-string or blank emails', async () => {
		for (const email of [123, '   ']) {
			await expect(POST(makeEvent({ token: 'demo-token', email }))).rejects.toMatchObject({
				status: 400,
				body: { message: 'Request body must include "email"' }
			});
		}
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects invalid database configuration before creating a session', async () => {
		vi.stubEnv('DATABASE_URL', 'postgres://example');

		await expect(
			POST(makeEvent({ token: 'demo-token', email: 'test@example.com' }))
		).rejects.toMatchObject({
			status: 503,
			body: {
				message: 'DATABASE_URL is not a valid Postgres connection string'
			}
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('creates a session and sets a signed HttpOnly cookie for a valid token', async () => {
		const event = makeEvent({ token: '  demo-token  ', email: '  not an email but useful  ' });
		const response = await POST(event);

		expect(response.status).toBe(201);
		expect(createDemoSession).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				email: 'not an email but useful',
				tokenHash: hashDemoToken('demo-token')
			})
		);
		expect(event.cookies.set).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' })
		);
	});

	it('returns a friendly 503 (not a bare Internal Error) when the database write fails', async () => {
		vi.mocked(createDemoSession).mockRejectedValueOnce(new Error('connection refused'));

		await expect(
			POST(makeEvent({ token: 'demo-token', email: 'test@example.com' }))
		).rejects.toMatchObject({
			status: 503,
			body: { message: 'Could not start a session. Please try again in a moment.' }
		});
	});
});
