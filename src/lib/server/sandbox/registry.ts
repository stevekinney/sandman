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
		_registry = {
			client: createSandboxClient(),
			handles: new Map()
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
	getSandboxRegistry().handles.set(sandboxId, handle);
}

/**
 * Remove a sandbox from the registry.
 * Call this after `client.terminate()` succeeds.
 */
export function deregisterHandle(sandboxId: string): void {
	getSandboxRegistry().handles.delete(sandboxId);
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
