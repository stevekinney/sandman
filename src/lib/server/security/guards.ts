import { error, type RequestEvent } from '@sveltejs/kit';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import {
	getActiveDemoSession,
	sandboxBelongsToSession,
	type DemoSessionRecord
} from '$lib/server/database/repository';
import {
	createSessionCookieOptions,
	createSignedSessionCookieValue,
	readSignedSessionCookieValue,
	SESSION_COOKIE_NAME
} from './session.ts';

export type AuthenticatedDemoSession = DemoSessionRecord;

export async function requireAuthenticatedDemoSession(
	event: RequestEvent
): Promise<AuthenticatedDemoSession> {
	const configuration = getProductionConfiguration();
	if (!configuration.sessionSecret) {
		throw error(503, 'SANDMAN_SESSION_SECRET is not configured');
	}

	const sessionId = readSignedSessionCookieValue(
		event.cookies.get(SESSION_COOKIE_NAME),
		configuration.sessionSecret
	);
	if (!sessionId) {
		throw error(401, 'A valid demo session is required');
	}
	if (!configuration.databaseUrl) {
		throw error(503, 'DATABASE_URL is not configured');
	}

	const session = await getActiveDemoSession(getDatabase(), { sessionId, now: new Date() });
	if (!session) {
		throw error(401, 'Demo session is no longer active');
	}
	event.cookies.set(
		SESSION_COOKIE_NAME,
		createSignedSessionCookieValue(sessionId, configuration.sessionSecret),
		createSessionCookieOptions(event.url, configuration.sessionTtlMs)
	);
	return session;
}

export async function requireOwnedSandbox(event: RequestEvent, sandboxId: string): Promise<string> {
	const session = await requireAuthenticatedDemoSession(event);
	const belongs = await sandboxBelongsToSession(getDatabase(), {
		sessionId: session.id,
		sandboxId
	});
	if (!belongs) {
		throw error(404, 'Sandbox not found for this demo session');
	}
	return session.id;
}
