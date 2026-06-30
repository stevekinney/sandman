import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import { getMonitoringSnapshot } from '$lib/server/database/repository';
import { requireAuthenticatedDemoSession } from '$lib/server/security/guards';

export const GET: RequestHandler = async (event) => {
	await requireAuthenticatedDemoSession(event);
	const configuration = getProductionConfiguration();
	const snapshot = await getMonitoringSnapshot(getDatabase(), {
		now: new Date(),
		globalLimit: configuration.maxActiveSandboxes
	});
	return json(snapshot);
};
