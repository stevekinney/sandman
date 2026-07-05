/**
 * hooks.server.ts — process-startup hooks.
 */

import type { ServerInit } from '@sveltejs/kit';
import { getSandboxRegistry } from '$lib/server/sandbox/registry';

/**
 * Eagerly initializes the sandbox registry (and its startup reconcile pass)
 * when the server process starts, rather than lazily on the first request to
 * touch a sandbox route. Without this, a redeployed process that only ever
 * receives health-check traffic before a real request never reaches
 * `getSandboxRegistry()`, so orphaned sandboxes from the previous process sit
 * unreclaimed indefinitely instead of within one reconcile interval.
 */
export const init: ServerInit = () => {
	getSandboxRegistry();
};
