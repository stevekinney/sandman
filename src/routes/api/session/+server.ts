import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import { createDemoSession } from '$lib/server/database/repository';
import {
	createSessionCookieOptions,
	createSignedSessionCookieValue,
	hashDemoToken,
	SESSION_COOKIE_NAME,
	validateDemoToken
} from '$lib/server/security/session';
import { assertSameOrigin } from '$lib/server/security/origin';
import { logError, logInfo, logWarning } from '$lib/server/logging';

function getStringField(value: unknown, field: string): string | null {
	if (typeof value !== 'object' || value === null) return null;
	const fieldValue = Reflect.get(value, field);
	return typeof fieldValue === 'string' ? fieldValue : null;
}

export const POST: RequestHandler = async (event) => {
	assertSameOrigin(event);

	const configuration = getProductionConfiguration();
	if (!configuration.demoTokenHash) throw error(503, 'SANDMAN_DEMO_TOKEN_SHA256 is not configured');
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

	const token = getStringField(body, 'token')?.trim();
	if (!token) {
		throw error(400, 'Request body must include "token"');
	}

	const email = getStringField(body, 'email')?.trim();
	if (!email) {
		throw error(400, 'Request body must include "email"');
	}

	if (!validateDemoToken(token, configuration.demoTokenHash)) {
		logWarning({ event: 'demo_session.rejected', status: 'invalid-token' });
		throw error(401, 'Invalid invite code');
	}

	const now = new Date();
	const sessionId = crypto.randomUUID();
	try {
		await createDemoSession(getDatabase(configuration.databaseUrl), {
			sessionId,
			tokenHash: hashDemoToken(token),
			email,
			now
		});
	} catch (err) {
		logError({ event: 'demo_session.create_failed', sessionId, status: 'error', error: err });
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
