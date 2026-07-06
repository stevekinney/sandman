/**
 * registry.ts — module-level singleton for active sandbox sessions.
 *
 * Holds the shared SandboxClient and a map of live handles so that both the
 * files route and the proxy route can look up the same sandbox object by ID.
 *
 * Import and call `getSandboxRegistry()` from server-only code. Never import
 * this module on the client.
 */

import type { SandboxClient, SandboxHandle } from '$lib/contracts/sandbox';
import { createSandboxClient } from './client.ts';
import { createReaper, type Reaper } from './reaper.ts';
import { createReconciler, type Reconciler } from './reconciler.ts';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import {
	getExpiredRegisteredSandboxIds,
	markExpiredSandboxes,
	markSandboxReclaimed,
	updateSandboxStatus
} from '$lib/server/database/repository';
import { SANDBOX_SESSION_STATUS } from '$lib/server/database/schema';
import { logError, logInfo } from '$lib/server/logging';

/**
 * How many expired sandboxes one reconcile pass will terminate. A pass that
 * hits the cap leaves the remainder for the next pass rather than fanning out
 * an unbounded number of E2B kill calls at once.
 */
const RECONCILE_BATCH_LIMIT = 25;

/** An active sandbox session: its handle + the client that owns it. */
export type SandboxEntry = {
	client: SandboxClient;
	handle: SandboxHandle;
};

/** Singleton state for the process lifetime. */
type Registry = {
	/** Shared SandboxClient — created once, manages all E2B sessions. */
	client: SandboxClient;
	/** Map from sandbox ID to live handle. */
	handles: Map<string, SandboxHandle>;
	reaper: Reaper;
	stopReaper: () => void;
	reconciler: Reconciler;
	stopReconciler: () => void;
};

let _registry: Registry | undefined;

/**
 * Returns (and lazily creates) the process-lifetime sandbox registry.
 *
 * The `SandboxClient` is constructed once on first call, and a startup
 * reconcile pass reclaims sandboxes orphaned by a previous server process
 * (their VMs are terminated at E2B and their database rows marked Expired).
 * Subsequent calls return the same registry instance.
 */
export function getSandboxRegistry(): Registry {
	if (!_registry) {
		const configuration = getProductionConfiguration();
		const client = createSandboxClient({
			apiKey: configuration.e2bApiKey,
			templateId: configuration.e2bTemplateId
		});
		const handles = new Map<string, SandboxHandle>();
		const reaper = createReaper(configuration.sessionTtlMs);
		const reconciler = createReconciler(
			{
				getExpiredSandboxIds: async (input) => {
					const ids = await getExpiredRegisteredSandboxIds(getDatabase(), input);
					// Exclude sandboxes this process still holds a handle for — e.g.
					// one whose bootstrap is outlasting the reservation window.
					// `expiresAt` is set at reservation time and isn't slid until
					// Ready, so it can lapse mid-bootstrap while the reaper (whose
					// TTL starts at registerHandle) still correctly treats the VM as
					// live. Those belong to the reaper, not the reconciler — killing
					// them here would abort a legitimate in-flight bootstrap.
					return ids.filter((id) => !handles.has(id));
				},
				terminateSandbox: async (sandboxId) => {
					await client.terminateById(sandboxId);
					handles.delete(sandboxId);
					reaper.unregister(sandboxId);
					logInfo({ event: 'sandbox.reconciler.terminated', sandboxId, status: 'expired' });
				},
				markSandboxReclaimed: (input) => markSandboxReclaimed(getDatabase(), input),
				markExpiredSandboxes: (input) => markExpiredSandboxes(getDatabase(), input),
				onError: (error, sandboxId) =>
					logError({ event: 'sandbox.reconciler.failed', sandboxId, status: 'error', error })
			},
			{ limit: RECONCILE_BATCH_LIMIT }
		);
		const intervalMs = Math.min(configuration.sessionTtlMs, 60_000);
		_registry = {
			client,
			handles,
			reaper,
			stopReaper: reaper.start(intervalMs),
			reconciler,
			stopReconciler: reconciler.start(intervalMs)
		};
		// Startup reconciliation: sandboxes left Ready/Provisioning/Bootstrapping
		// by the previous process are invisible to the in-memory reaper, so
		// reclaim them now instead of waiting for their provider timeout.
		void reconciler.tick();
	}
	return _registry;
}

/**
 * Register a provisioned sandbox handle so route resolvers can look it up.
 *
 * Call this after `client.provision()` succeeds.
 */
export function registerHandle(sandboxId: string, handle: SandboxHandle): void {
	const registry = getSandboxRegistry();
	registry.handles.set(sandboxId, handle);
	registry.reaper.register(sandboxId, Date.now(), async () => {
		const startedAt = performance.now();
		try {
			await registry.client.terminate(handle);
			deregisterHandle(sandboxId);
			await updateSandboxStatus(getDatabase(), {
				sandboxId,
				status: SANDBOX_SESSION_STATUS.Expired,
				now: new Date(),
				reclaimed: true
			});
			logInfo({
				event: 'sandbox.reaper.terminated',
				sandboxId,
				status: 'expired',
				durationMs: Math.round(performance.now() - startedAt)
			});
		} catch (err) {
			logError({
				event: 'sandbox.reaper.failed',
				sandboxId,
				status: 'error',
				durationMs: Math.round(performance.now() - startedAt),
				error: err
			});
			throw err;
		}
	});
}

/**
 * Slide a sandbox's in-memory reaper TTL forward, keyed on real user
 * activity. Call this alongside the database-level touch so the reaper's
 * timer and the persisted `expiresAt` never drift apart. A no-op if the
 * sandbox is not registered.
 */
export function touchHandle(sandboxId: string): void {
	getSandboxRegistry().reaper.touch(sandboxId);
}

/**
 * Slide the provider-side sandbox timeout forward. A no-op if the sandbox is
 * not registered in this server process.
 */
export async function extendHandleTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
	const entry = resolveEntry(sandboxId);
	if (!entry) return;
	await entry.client.extendTimeout(entry.handle, timeoutMs);
}

/**
 * Remove a sandbox from the registry.
 * Call this after `client.terminate()` succeeds.
 */
export function deregisterHandle(sandboxId: string): void {
	const registry = getSandboxRegistry();
	registry.handles.delete(sandboxId);
	registry.reaper.unregister(sandboxId);
}

/**
 * Resolve the client and handle for a sandbox ID.
 * Returns `null` when the sandbox is not yet registered (not provisioned).
 */
export function resolveEntry(sandboxId: string): SandboxEntry | null {
	const registry = getSandboxRegistry();
	const handle = registry.handles.get(sandboxId);
	if (!handle) return null;
	return { client: registry.client, handle };
}

/**
 * Resolve just the handle for a sandbox ID.
 * Returns `null` when the sandbox is not yet registered.
 */
export function resolveHandle(sandboxId: string): SandboxHandle | null {
	return getSandboxRegistry().handles.get(sandboxId) ?? null;
}
