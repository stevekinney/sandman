/**
 * hooks.server.ts — process-startup and error-handling hooks.
 */

import type { HandleServerError, ServerInit } from '@sveltejs/kit';
import { getSandboxRegistry } from '$lib/server/sandbox/registry';
import { logError } from '$lib/server/logging';

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

/**
 * Logs an unhandled request error and returns the friendly replacement
 * message. Takes only what it needs from the request event (rather than the
 * full `RequestEvent`) so it can be exercised directly in tests without
 * fabricating — or asserting past — SvelteKit's much larger event shape.
 */
export function logUnhandledError(err: unknown, event: { url: URL }, status: number): App.Error {
	logError({
		event: 'request.unhandled_error',
		status: String(status),
		path: event.url.pathname,
		error: err
	});

	return {
		message: 'Something went wrong on our end. Please try again in a moment.'
	};
}

/**
 * Safety net for errors that escape a route handler's own try/catch (e.g. an
 * unexpected DB or dependency failure). Logs the real error server-side and
 * replaces SvelteKit's bare "Internal Error" with a message the browser can
 * show the user without leaking internals.
 */
export const handleError: HandleServerError = ({ error: err, event, status }) =>
	logUnhandledError(err, event, status);
