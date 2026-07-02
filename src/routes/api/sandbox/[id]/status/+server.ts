import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database/connection';
import { getOwnedSandboxStatus } from '$lib/server/database/repository';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import { resolveEntry } from '$lib/server/sandbox/registry';

export const GET: RequestHandler = async (event) => {
	const { id } = event.params;
	const sessionId = await requireOwnedSandbox(event, id);
	const status = await getOwnedSandboxStatus(getDatabase(), { sessionId, sandboxId: id });
	if (!status) throw error(404, 'Sandbox not found for this demo session');

	// Live process state (server/worker) survives a browser reload because the
	// client handle lives in this server process. `null` when the handle is
	// gone (e.g. after a server restart), which the UI treats as "unknown" and
	// leaves its current liveness untouched.
	const entry = resolveEntry(id);
	const processes = entry?.client.processLiveness(entry.handle) ?? null;

	return json({ ...status, processes });
};
