import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import { createDemoSession } from '$lib/server/database/repository';
import {
	createSignedSessionCookieValue,
	hashDemoToken,
	SESSION_COOKIE_NAME,
	validateDemoToken
} from '$lib/server/security/session';
import { assertSameOrigin } from '$lib/server/security/origin';
import { logInfo, logWarning } from '$lib/server/logging';

type SessionRequestBody = {
	token: string;
};

function isSessionRequestBody(value: unknown): value is SessionRequestBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).token === 'string'
	);
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

	if (!isSessionRequestBody(body)) {
		throw error(400, 'Request body must include "token"');
	}

	if (!validateDemoToken(body.token, configuration.demoTokenHash)) {
		logWarning({ event: 'demo_session.rejected', status: 'invalid-token' });
		throw error(401, 'Invalid demo token');
	}

	const now = new Date();
	const sessionId = crypto.randomUUID();
	await createDemoSession(getDatabase(configuration.databaseUrl), {
		sessionId,
		tokenHash: hashDemoToken(body.token),
		now
	});

	event.cookies.set(
		SESSION_COOKIE_NAME,
		createSignedSessionCookieValue(sessionId, configuration.sessionSecret),
		{
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			path: '/',
			maxAge: Math.ceil(configuration.sessionTtlMs / 1000)
		}
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
