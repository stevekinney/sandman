/**
 * +server.ts — POST /api/session/heartbeat
 *
 * Lightweight, high-frequency-safe endpoint the session page calls (throttled)
 * on genuine user activity to slide the sliding-idle-timeout. It refreshes the
 * demo session cookie's TTL and, when the caller owns an active sandbox, slides
 * that sandbox's expiry too. See `touchSessionHeartbeat` for the full contract.
 *
 * The request body is optional and best-effort: a missing, empty, or malformed
 * body simply means "no sandbox to slide" — never a 400. Only the same-origin
 * check and a valid session cookie are hard requirements.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/server/security/origin';
import { touchSessionHeartbeat } from '$lib/server/security/guards';

function readOptionalSandboxId(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null || !('sandboxId' in body)) {
		return undefined;
	}
	const { sandboxId } = body;
	return typeof sandboxId === 'string' && sandboxId.length > 0 ? sandboxId : undefined;
}

export const POST: RequestHandler = async (event) => {
	assertSameOrigin(event);

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		// Heartbeat bodies are optional — an empty or non-JSON body means "no
		// sandbox to slide", not a bad request. Do not 400 here.
		body = undefined;
	}

	const { sandboxTouched } = await touchSessionHeartbeat(event, readOptionalSandboxId(body));
	return json({ ok: true, sandboxTouched });
};
