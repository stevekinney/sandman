import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProductionConfiguration } from '$lib/server/configuration';
import { getDatabase } from '$lib/server/database/connection';
import { getMonitoringSnapshot } from '$lib/server/database/repository';
import { requireAuthenticatedDemoSession } from '$lib/server/security/guards';
import { logError } from '$lib/server/logging';

export const GET: RequestHandler = async (event) => {
	await requireAuthenticatedDemoSession(event);
	const configuration = getProductionConfiguration();
	let snapshot: Awaited<ReturnType<typeof getMonitoringSnapshot>>;
	try {
		snapshot = await getMonitoringSnapshot(getDatabase(), {
			now: new Date(),
			globalLimit: configuration.maxActiveSandboxes
		});
	} catch (err) {
		logError({ event: 'monitoring.snapshot.failed', status: 'error', error: err });
		throw error(503, 'Could not load monitoring data. Please try again in a moment.');
	}
	return json(snapshot);
};
