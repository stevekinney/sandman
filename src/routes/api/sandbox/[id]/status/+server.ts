import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database/connection';
import { getOwnedSandboxStatus } from '$lib/server/database/repository';
import { requireOwnedSandbox } from '$lib/server/security/guards';

export const GET: RequestHandler = async (event) => {
	const { id } = event.params;
	const sessionId = await requireOwnedSandbox(event, id);
	const status = await getOwnedSandboxStatus(getDatabase(), { sessionId, sandboxId: id });
	if (!status) throw error(404, 'Sandbox not found for this demo session');
	return json(status);
};
