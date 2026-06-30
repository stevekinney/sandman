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
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import { updateSandboxStatus } from '$lib/server/database/repository';
import { SANDBOX_SESSION_STATUS } from '$lib/server/database/schema';
import { logError, logInfo } from '$lib/server/logging';

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
};

let _registry: Registry | undefined;

/**
 * Returns (and lazily creates) the process-lifetime sandbox registry.
 *
 * The `SandboxClient` is constructed once on first call. Subsequent calls
 * return the same registry instance.
 */
export function getSandboxRegistry(): Registry {
	if (!_registry) {
		const configuration = getProductionConfiguration();
		const reaper = createReaper(configuration.sessionTtlMs);
		_registry = {
			client: createSandboxClient(),
			handles: new Map(),
			reaper,
			stopReaper: reaper.start(Math.min(configuration.sessionTtlMs, 60_000))
		};
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
				now: new Date()
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
