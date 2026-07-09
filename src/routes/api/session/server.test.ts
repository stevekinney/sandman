import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './+server.ts';
import { hashDemoToken, SESSION_COOKIE_NAME } from '$lib/server/security/session';
import {
	createDemoSession,
	decrementRateLimitBucket,
	incrementRateLimitBucket
} from '$lib/server/database/repository';

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	createDemoSession: vi.fn().mockResolvedValue(undefined),
	decrementRateLimitBucket: vi.fn().mockResolvedValue(0),
	incrementRateLimitBucket: vi.fn().mockResolvedValue(1)
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
		vi.stubEnv('SANDMAN_SESSION_CREATIONS_PER_VISITOR_PER_HOUR', '5');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it('rejects invalid invite codes', async () => {
		vi.stubEnv('SANDMAN_INVITE_CODE_REQUIRED', 'true');

		await expect(
			POST(makeEvent({ token: 'wrong-token', email: 'test@example.com' }))
		).rejects.toMatchObject({
			status: 401
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects mismatched origins', async () => {
		await expect(
			POST(makeEvent({ email: 'test@example.com' }, 'https://evil.example'))
		).rejects.toMatchObject({
			status: 403
		});
	});

	it('rejects requests without an email', async () => {
		await expect(POST(makeEvent({}))).rejects.toMatchObject({
			status: 400,
			body: { message: 'Request body must include "email"' }
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects non-string or blank invite codes when invite codes are required', async () => {
		vi.stubEnv('SANDMAN_INVITE_CODE_REQUIRED', 'true');

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
			await expect(POST(makeEvent({ email }))).rejects.toMatchObject({
				status: 400,
				body: { message: 'Request body must include "email"' }
			});
		}
		expect(createDemoSession).not.toHaveBeenCalled();
		expect(incrementRateLimitBucket).not.toHaveBeenCalled();
	});

	it('rejects malformed email strings before writing a session row', async () => {
		for (const email of ['visitor', 'visitor@', '@example.com', 'visitor@example']) {
			await expect(POST(makeEvent({ email }))).rejects.toMatchObject({
				status: 400,
				body: { message: 'Request body must include a valid email' }
			});
		}
		expect(createDemoSession).not.toHaveBeenCalled();
		expect(incrementRateLimitBucket).not.toHaveBeenCalled();
	});

	it('rate-limits email-only session creation before writing a session row', async () => {
		vi.mocked(incrementRateLimitBucket).mockResolvedValueOnce(6);

		await expect(POST(makeEvent({ email: 'visitor@example.com' }))).rejects.toMatchObject({
			status: 429,
			body: { message: 'This visitor has reached the hourly session creation limit' }
		});

		expect(incrementRateLimitBucket).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				key: `session-create:${hashDemoToken('invite-code-disabled-email:visitor@example.com')}`,
				windowStart: expect.any(Date),
				now: expect.any(Date)
			})
		);
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('rejects invalid database configuration before creating a session', async () => {
		vi.stubEnv('DATABASE_URL', 'postgres://example');

		await expect(POST(makeEvent({ email: 'test@example.com' }))).rejects.toMatchObject({
			status: 503,
			body: {
				message: 'DATABASE_URL is not a valid Postgres connection string'
			}
		});
		expect(createDemoSession).not.toHaveBeenCalled();
	});

	it('creates a session and sets a signed HttpOnly cookie without an invite code', async () => {
		const event = makeEvent({ email: '  Visitor@Example.COM  ' });
		const response = await POST(event);

		expect(response.status).toBe(201);
		expect(createDemoSession).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				email: 'Visitor@Example.COM',
				tokenHash: hashDemoToken('invite-code-disabled-email:visitor@example.com')
			})
		);
		expect(incrementRateLimitBucket).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				key: `session-create:${hashDemoToken('invite-code-disabled-email:visitor@example.com')}`
			})
		);
		expect(event.cookies.set).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' })
		);
	});

	it('uses the same no-invite quota hash for the same email casing and whitespace', async () => {
		await POST(makeEvent({ email: ' Visitor@Example.COM ' }));
		await POST(makeEvent({ email: 'visitor@example.com' }));

		const firstCall = vi.mocked(createDemoSession).mock.calls[0]?.[1];
		const secondCall = vi.mocked(createDemoSession).mock.calls[1]?.[1];
		expect(firstCall?.tokenHash).toBe(secondCall?.tokenHash);
	});

	it('preserves invite-code validation when invite codes are required', async () => {
		vi.stubEnv('SANDMAN_INVITE_CODE_REQUIRED', 'true');
		const event = makeEvent({ token: '  demo-token  ', email: '  visitor@example.com  ' });
		const response = await POST(event);

		expect(response.status).toBe(201);
		expect(createDemoSession).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				email: 'visitor@example.com',
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

		await expect(POST(makeEvent({ email: 'test@example.com' }))).rejects.toMatchObject({
			status: 503,
			body: { message: 'Could not start a session. Please try again in a moment.' }
		});
		expect(decrementRateLimitBucket).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				key: `session-create:${hashDemoToken('invite-code-disabled-email:test@example.com')}`,
				windowStart: expect.any(Date),
				now: expect.any(Date)
			})
		);
	});
});
