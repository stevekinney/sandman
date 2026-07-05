/**
 * +server.ts — POST /api/sandbox
 *
 * Provisions a new E2B sandbox and registers it so the files and proxy routes
 * can resolve it by ID.
 *
 * GATED on `E2B_API_KEY`: returns 503 with a descriptive body when the key is
 * absent so the browser can degrade gracefully to demo mode.
 *
 * Response: `{ sandboxId: string; uiUrl: string }`
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deregisterHandle, getSandboxRegistry, registerHandle } from '$lib/server/sandbox/registry';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import {
	attachSandboxToReservation,
	decrementRateLimitBucket,
	incrementRateLimitBucket,
	markSandboxReservationError,
	reserveSandboxSlot,
	updateSandboxStatus
} from '$lib/server/database/repository';
import { SANDBOX_SESSION_STATUS } from '$lib/server/database/schema';
import { requireAuthenticatedDemoSession } from '$lib/server/security/guards';
import { assertSameOrigin } from '$lib/server/security/origin';
import { logError, logInfo, logWarning } from '$lib/server/logging';

export const POST: RequestHandler = async (event) => {
	assertSameOrigin(event);
	const configuration = getProductionConfiguration();
	const session = await requireAuthenticatedDemoSession(event);

	if (!configuration.e2bApiKey) {
		throw error(
			503,
			'E2B_API_KEY is not set — live sandboxes are unavailable. ' +
				'Set E2B_API_KEY in your environment to enable provisioning.'
		);
	}
	if (configuration.isProduction && !configuration.e2bTemplateId) {
		throw error(503, 'E2B_TEMPLATE_ID is required in production');
	}

	const database = getDatabase();
	const now = new Date();
	const rateLimitKey = `session-create:${session.tokenHash}`;
	const rateLimitWindowStart = getHourWindowStart(now);
	const rateLimitCount = await incrementRateLimitBucket(database, {
		key: rateLimitKey,
		windowStart: rateLimitWindowStart,
		now
	});
	if (rateLimitCount > configuration.sessionCreationsPerTokenPerHour) {
		logWarning({ event: 'sandbox.provision.blocked', sessionId: session.id, status: 'rate-limit' });
		throw error(429, 'This invite code has reached its hourly session creation limit');
	}

	const reservation = await reserveSandboxSlot(database, {
		sessionId: session.id,
		now,
		expiresAt: new Date(now.getTime() + configuration.sessionTtlMs),
		globalLimit: configuration.maxActiveSandboxes,
		perSessionLimit: configuration.maxActiveSandboxesPerSession
	});
	if (reservation.status !== 'reserved') {
		await decrementRateLimitBucket(database, {
			key: rateLimitKey,
			windowStart: rateLimitWindowStart,
			now: new Date()
		});
		logWarning({
			event: 'sandbox.provision.blocked',
			sessionId: session.id,
			status: reservation.status
		});
		throw error(
			429,
			reservation.status === 'session-limit'
				? 'This demo session already has an active sandbox'
				: 'Sandman is at its active sandbox limit'
		);
	}

	const registry = getSandboxRegistry();
	const startedAt = performance.now();
	let handle: Awaited<ReturnType<typeof registry.client.provision>> | undefined;
	try {
		handle = await registry.client.provision();
		registerHandle(handle.id, handle);
		await attachSandboxToReservation(database, {
			reservationId: reservation.reservationId,
			sandboxId: handle.id,
			now: new Date()
		});
	} catch (err) {
		await markSandboxReservationError(database, {
			reservationId: reservation.reservationId,
			now: new Date(),
			errorMessage: err instanceof Error ? err.message : String(err)
		});
		await decrementRateLimitBucket(database, {
			key: rateLimitKey,
			windowStart: rateLimitWindowStart,
			now: new Date()
		});
		if (handle !== undefined) {
			try {
				await registry.client.terminate(handle);
				deregisterHandle(handle.id);
			} catch (terminationError) {
				logError({
					event: 'sandbox.provision_cleanup.failed',
					sessionId: session.id,
					sandboxId: handle.id,
					status: 'error',
					error: terminationError
				});
			}
		}
		logError({
			event: 'sandbox.provision.failed',
			sessionId: session.id,
			sandboxId: handle?.id,
			status: 'error',
			durationMs: Math.round(performance.now() - startedAt),
			error: err
		});
		throw error(503, getProvisionFailureMessage(err));
	}

	logInfo({
		event: 'sandbox.provision.succeeded',
		sessionId: session.id,
		sandboxId: handle.id,
		status: 'provisioning',
		durationMs: Math.round(performance.now() - startedAt)
	});

	// Bootstrap runs asynchronously so the page can render while the sandbox
	// warms up. The worker status strip will reflect readiness.
	void (async () => {
		const bootstrapStartedAt = performance.now();
		try {
			await updateSandboxStatus(database, {
				sandboxId: handle.id,
				status: SANDBOX_SESSION_STATUS.Bootstrapping,
				now: new Date()
			});
			const result = await registry.client.bootstrap(handle);
			const completedAt = new Date();
			await updateSandboxStatus(database, {
				sandboxId: handle.id,
				status: result.ready ? SANDBOX_SESSION_STATUS.Ready : SANDBOX_SESSION_STATUS.Error,
				now: completedAt,
				expiresAt: result.ready
					? new Date(completedAt.getTime() + configuration.sessionTtlMs)
					: undefined,
				errorMessage: result.ready ? undefined : 'Temporal server did not become ready'
			});
			logInfo({
				event: 'sandbox.bootstrap.completed',
				sessionId: session.id,
				sandboxId: handle.id,
				status: result.ready ? 'ready' : 'not-ready',
				durationMs: Math.round(performance.now() - bootstrapStartedAt)
			});
		} catch (err) {
			await updateSandboxStatus(database, {
				sandboxId: handle.id,
				status: SANDBOX_SESSION_STATUS.Error,
				now: new Date(),
				errorMessage: err instanceof Error ? err.message : String(err)
			});
			logError({
				event: 'sandbox.bootstrap.failed',
				sessionId: session.id,
				sandboxId: handle.id,
				status: 'error',
				durationMs: Math.round(performance.now() - bootstrapStartedAt),
				error: err
			});
		}
	})();

	return json({ sandboxId: handle.id });
};

function getHourWindowStart(now: Date): Date {
	const windowStart = new Date(now);
	windowStart.setUTCMinutes(0, 0, 0);
	return windowStart;
}

function getProvisionFailureMessage(err: unknown): string {
	if (err instanceof Error && err.name === 'AuthenticationError') {
		return 'E2B_API_KEY is invalid or missing';
	}
	return 'Failed to provision sandbox';
}
