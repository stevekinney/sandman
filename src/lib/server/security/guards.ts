import { error, isHttpError, type RequestEvent } from '@sveltejs/kit';
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

/**
 * Slides the current demo session's idle expiry from a lightweight client
 * activity heartbeat — the sliding-idle-timeout counterpart to
 * `touchSessionActivity`. The client (see `[sessionId]/+page.svelte`) fires
 * this on genuine user gestures (throttled), NOT on the background status
 * poll, so an idle-but-open tab still times out instead of keeping a billed
 * sandbox alive forever.
 *
 * Deliberately NOT a variant of `touchSessionActivity`, which is a mutation
 * guard that hard-fails (410) on a stale sandbox because a mutation must not
 * proceed against a dead sandbox. This one is intentionally lenient on the
 * sandbox side:
 *  - The demo-session slide is authoritative: a missing/invalid cookie or an
 *    inactive session row rejects the heartbeat (401), and an unexpected DB
 *    failure on that call becomes a 503 — the cookie is only refreshed once
 *    the DB confirms the session is still active. Demo-session expiry is
 *    enforced ONLY by the signed cookie's `maxAge` (there is no server-side
 *    `lastSeenAt` reaper), so this cookie refresh — not the DB write — is what
 *    actually extends the session's lifetime.
 *  - The sandbox slide is best-effort: an already-expired/inactive sandbox
 *    reports `sandboxTouched: false` without failing the request (the 2s
 *    status poll is the UI's channel for surfacing sandbox expiry), and any
 *    DB/provider error while sliding the sandbox degrades to
 *    `sandboxTouched: false` rather than failing the whole heartbeat. A
 *    `sandboxId` that isn't owned by this session is still rejected (404),
 *    because `touchSandboxSession` filters only on the sandbox id — without
 *    the ownership check any session could extend any other session's sandbox.
 */
export async function touchSessionHeartbeat(
	event: SessionActivityEvent,
	sandboxId: string | undefined
): Promise<{ sandboxTouched: boolean }> {
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

	const now = new Date();
	const database = getDatabase();

	let demoSessionTouched: boolean;
	try {
		demoSessionTouched = await touchActiveDemoSession(database, { sessionId, now });
	} catch (err) {
		logError({ event: 'session.heartbeat.failed', sessionId, status: 'error', error: err });
		throw error(503, 'Could not record activity. Please try again in a moment.');
	}
	if (!demoSessionTouched) {
		throw error(401, 'Demo session is no longer active');
	}

	// Refresh the cookie's maxAge BEFORE any sandbox work — this refresh (not
	// the DB touch above) is what extends the demo session, and the sandbox
	// path is lenient, so a stale/foreign sandbox claim must not block the
	// legitimate session-wide slide that already succeeded.
	event.cookies.set(
		SESSION_COOKIE_NAME,
		createSignedSessionCookieValue(sessionId, configuration.sessionSecret),
		createSessionCookieOptions(event.url, configuration.sessionTtlMs)
	);

	if (!sandboxId) {
		return { sandboxTouched: false };
	}

	try {
		const owned = await sandboxBelongsToSession(database, { sessionId, sandboxId });
		if (!owned) {
			throw error(404, 'Sandbox not found for this demo session');
		}

		const sandboxTouched = await touchSandboxSession(database, {
			sandboxId,
			now,
			ttlMs: configuration.sessionTtlMs
		});
		if (!sandboxTouched) {
			return { sandboxTouched: false };
		}

		touchHandle(sandboxId);
		try {
			await extendHandleTimeout(sandboxId, configuration.sessionTtlMs);
		} catch (err) {
			logError({
				event: 'session.heartbeat.extend_failed',
				sandboxId,
				sessionId,
				status: 'error',
				error: err
			});
		}
		return { sandboxTouched: true };
	} catch (err) {
		// A genuine ownership rejection (404) must reach the caller; only an
		// unexpected DB failure degrades — the demo session was already slid, so
		// the heartbeat still succeeded for the part that keeps the demo alive.
		if (isHttpError(err)) throw err;
		logError({
			event: 'session.heartbeat.sandbox_failed',
			sandboxId,
			sessionId,
			status: 'error',
			error: err
		});
		return { sandboxTouched: false };
	}
}
