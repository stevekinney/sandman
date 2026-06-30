import { getProductionConfiguration } from '$lib/server/configuration';
import { probeDatabase } from '$lib/server/database/connection';
import { createHealthResponse } from './health-response';

export async function GET(): Promise<Response> {
	return createHealthResponse(getProductionConfiguration(), {
		database: () => probeDatabase()
	});
}
