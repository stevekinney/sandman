import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database/connection';
import { getOwnedSandboxStatus } from '$lib/server/database/repository';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import { resolveEntry } from '$lib/server/sandbox/registry';
import { logError } from '$lib/server/logging';

export const GET: RequestHandler = async (event) => {
	const { id } = event.params;
	const sessionId = await requireOwnedSandbox(event, id);
	let status: Awaited<ReturnType<typeof getOwnedSandboxStatus>>;
	try {
		status = await getOwnedSandboxStatus(getDatabase(), { sessionId, sandboxId: id });
	} catch (err) {
		logError({
			event: 'sandbox.status.failed',
			sessionId,
			sandboxId: id,
			status: 'error',
			error: err
		});
		throw error(503, 'Could not load sandbox status. Please try again in a moment.');
	}
	if (!status) throw error(404, 'Sandbox not found for this demo session');

	// Live process state (server/worker) survives a browser reload because the
	// client handle lives in this server process. `null` when the handle is
	// gone (e.g. after a server restart), which the UI treats as "unknown" and
	// leaves its current liveness untouched.
	const entry = resolveEntry(id);
	const processes = entry?.client.processLiveness(entry.handle) ?? null;

	return json({ ...status, processes });
};
