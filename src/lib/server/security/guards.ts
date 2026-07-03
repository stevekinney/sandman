import { error, type RequestEvent } from '@sveltejs/kit';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import {
	getActiveDemoSession,
	sandboxBelongsToSession,
	touchActiveDemoSession,
	touchSandboxSession,
	type DemoSessionRecord
} from '$lib/server/database/repository';
import { extendHandleTimeout, touchHandle } from '$lib/server/sandbox/registry';
import { logError } from '$lib/server/logging';
import {
	createSessionCookieOptions,
	createSignedSessionCookieValue,
	readSignedSessionCookieValue,
	SESSION_COOKIE_NAME
} from './session.ts';

export type AuthenticatedDemoSession = DemoSessionRecord;

type SessionCookieReader = {
	cookies: Pick<RequestEvent['cookies'], 'get'>;
};

type SessionActivityEvent = {
	url: RequestEvent['url'];
	cookies: Pick<RequestEvent['cookies'], 'get' | 'set'>;
};

/**
 * Validates the signed session cookie and looks up the active demo session.
 *
 * This is a read-only check — it does NOT slide the session's expiry. It is
 * called by every guarded route, including passive polling GETs, so sliding
 * here would let an idle-but-open tab keep a session alive forever. Only
 * `touchSessionActivity` (called from mutation routes) slides expiry.
 */
export async function requireAuthenticatedDemoSession(
	event: SessionCookieReader
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

	const session = await getActiveDemoSession(getDatabase(), { sessionId });
	if (!session) {
		throw error(401, 'Demo session is no longer active');
	}
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

/**
 * Slides idle-based (sliding) expiry for the current demo session and the
 * given sandbox session: extends both rows' expiry by the configured TTL,
 * refreshes the session cookie's `maxAge`, and resets the in-memory sandbox
 * reaper timer so it doesn't reap out from under active use.
 *
 * Call this after a mutation route's auth/ownership guards succeed — only
 * user-intent mutations (workflow start/signal/update, file writes, worker
 * kill/restart, server stop/start) count as activity. Passive GETs (status
 * polling, queries, visibility) must never call this.
 *
 * If either database row is no longer active, the mutation must be rejected:
 * ownership alone is not enough to allow stale sandbox mutations after expiry.
 * Provider timeout refresh remains best-effort after local expiry state has
 * already been refreshed.
 */
export async function touchSessionActivity(
	event: SessionActivityEvent,
	sandboxId: string
): Promise<void> {
	const configuration = getProductionConfiguration();
	if (!configuration.sessionSecret) return;

	const sessionId = readSignedSessionCookieValue(
		event.cookies.get(SESSION_COOKIE_NAME),
		configuration.sessionSecret
	);
	if (!sessionId) return;

	const now = new Date();
	const database = getDatabase();
	const demoSessionTouched = await touchActiveDemoSession(database, { sessionId, now });
	if (!demoSessionTouched) {
		throw error(401, 'Demo session is no longer active');
	}

	const sandboxSessionTouched = await touchSandboxSession(database, {
		sandboxId,
		now,
		ttlMs: configuration.sessionTtlMs
	});
	if (!sandboxSessionTouched) {
		throw error(410, 'Sandbox session is no longer active');
	}

	event.cookies.set(
		SESSION_COOKIE_NAME,
		createSignedSessionCookieValue(sessionId, configuration.sessionSecret),
		createSessionCookieOptions(event.url, configuration.sessionTtlMs)
	);

	touchHandle(sandboxId);
	try {
		await extendHandleTimeout(sandboxId, configuration.sessionTtlMs);
	} catch (err) {
		logError({ event: 'session.touch.failed', sandboxId, error: err });
	}
}
