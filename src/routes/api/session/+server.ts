import { error, isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import {
	createDemoSession,
	decrementRateLimitBucket,
	incrementRateLimitBucket
} from '$lib/server/database/repository';
import {
	createSessionCookieOptions,
	createSignedSessionCookieValue,
	hashDemoToken,
	SESSION_COOKIE_NAME,
	validateDemoToken
} from '$lib/server/security/session';
import { assertSameOrigin } from '$lib/server/security/origin';
import { logError, logInfo, logWarning } from '$lib/server/logging';

const INVITE_CODE_DISABLED_EMAIL_PREFIX = 'invite-code-disabled-email';
const SESSION_CREATION_RATE_LIMIT_PREFIX = 'session-create';

function getStringField(value: unknown, field: string): string | null {
	if (typeof value !== 'object' || value === null) return null;
	const fieldValue = Reflect.get(value, field);
	return typeof fieldValue === 'string' ? fieldValue : null;
}

export const POST: RequestHandler = async (event) => {
	assertSameOrigin(event);

	const configuration = getProductionConfiguration();
	if (configuration.inviteCodeRequired && !configuration.demoTokenHash) {
		throw error(503, 'SANDMAN_DEMO_TOKEN_SHA256 is not configured');
	}
	if (!configuration.sessionSecret) throw error(503, 'SANDMAN_SESSION_SECRET is not configured');
	if (!configuration.databaseUrl) throw error(503, 'DATABASE_URL is not configured');
	if (!isPostgresConnectionString(configuration.databaseUrl)) {
		throw error(503, 'DATABASE_URL is not a valid Postgres connection string');
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, 'Request body must be valid JSON');
	}

	const email = getStringField(body, 'email')?.trim();
	if (!email) {
		throw error(400, 'Request body must include "email"');
	}
	if (!isEmailAddress(email)) {
		throw error(400, 'Request body must include a valid email');
	}

	const now = new Date();
	const sessionId = crypto.randomUUID();
	const tokenHash = getSessionTokenHash(body, configuration, email);
	const database = getDatabase(configuration.databaseUrl);
	const rateLimitKey = `${SESSION_CREATION_RATE_LIMIT_PREFIX}:${getEmailQuotaHash(email)}`;
	const rateLimitWindowStart = getHourWindowStart(now);
	let rateLimitIncremented = false;
	try {
		const rateLimitCount = await incrementRateLimitBucket(database, {
			key: rateLimitKey,
			windowStart: rateLimitWindowStart,
			now
		});
		rateLimitIncremented = true;
		if (rateLimitCount > configuration.sessionCreationsPerVisitorPerHour) {
			logWarning({ event: 'demo_session.blocked', sessionId, status: 'rate-limit' });
			throw error(429, 'This visitor has reached the hourly session creation limit');
		}

		await createDemoSession(database, {
			sessionId,
			tokenHash,
			email,
			now
		});
	} catch (err) {
		if (isHttpError(err)) throw err;
		if (rateLimitIncremented) {
			try {
				await decrementRateLimitBucket(database, {
					key: rateLimitKey,
					windowStart: rateLimitWindowStart,
					now: new Date()
				});
			} catch (rollbackErr) {
				logError({
					event: 'demo_session.rate_limit_rollback.failed',
					sessionId,
					status: 'error',
					error: rollbackErr
				});
			}
		}
		logError({
			event: rateLimitIncremented ? 'demo_session.create_failed' : 'demo_session.rate_limit.failed',
			sessionId,
			status: 'error',
			error: err
		});
		throw error(503, 'Could not start a session. Please try again in a moment.');
	}

	event.cookies.set(
		SESSION_COOKIE_NAME,
		createSignedSessionCookieValue(sessionId, configuration.sessionSecret),
		createSessionCookieOptions(event.url, configuration.sessionTtlMs)
	);

	logInfo({ event: 'demo_session.created', sessionId, status: 'created' });
	return json({ ok: true }, { status: 201 });
};

function isPostgresConnectionString(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'postgresql:' && url.hostname.length > 0 && url.pathname.length > 1;
	} catch {
		return false;
	}
}

function getSessionTokenHash(
	body: unknown,
	configuration: ReturnType<typeof getProductionConfiguration>,
	email: string
): string {
	if (!configuration.inviteCodeRequired) {
		return getEmailQuotaHash(email);
	}

	const token = getStringField(body, 'token')?.trim();
	if (!token) {
		throw error(400, 'Request body must include "token"');
	}

	if (!configuration.demoTokenHash || !validateDemoToken(token, configuration.demoTokenHash)) {
		logWarning({ event: 'demo_session.rejected', status: 'invalid-token' });
		throw error(401, 'Invalid invite code');
	}

	return hashDemoToken(token);
}

function normalizeEmailForQuota(email: string): string {
	return email.trim().toLowerCase();
}

function getEmailQuotaHash(email: string): string {
	return hashDemoToken(`${INVITE_CODE_DISABLED_EMAIL_PREFIX}:${normalizeEmailForQuota(email)}`);
}

function getHourWindowStart(now: Date): Date {
	const windowStart = new Date(now);
	windowStart.setUTCMinutes(0, 0, 0);
	return windowStart;
}

function isEmailAddress(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
