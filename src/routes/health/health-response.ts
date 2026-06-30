import {
	getMissingProductionRequirements,
	type ProductionConfiguration
} from '$lib/server/configuration';

export type HealthDependency = {
	name: 'configuration' | 'database';
	ok: boolean;
	detail?: string;
};

export async function createHealthResponse(
	configuration: ProductionConfiguration,
	probes: { database?: () => Promise<void> } = {}
): Promise<Response> {
	const dependencies: HealthDependency[] = [
		checkConfiguration(configuration),
		await checkDatabase(configuration, probes.database)
	];
	const ok = dependencies.every((dependency) => dependency.ok);
	return Response.json({ ok, dependencies }, { status: ok ? 200 : 503 });
}

function checkConfiguration(configuration: ProductionConfiguration): HealthDependency {
	const missing = getMissingProductionRequirements(configuration);
	if (missing.length === 0) return { name: 'configuration', ok: true };
	return {
		name: 'configuration',
		ok: false,
		detail: `Missing ${missing.join(', ')}`
	};
}

async function checkDatabase(
	configuration: ProductionConfiguration,
	database: (() => Promise<void>) | undefined
): Promise<HealthDependency> {
	if (!configuration.databaseUrl) {
		return { name: 'database', ok: false, detail: 'DATABASE_URL is not configured' };
	}
	if (!database) return { name: 'database', ok: true };
	try {
		await database();
		return { name: 'database', ok: true };
	} catch (err) {
		return {
			name: 'database',
			ok: false,
			detail: err instanceof Error ? err.message : 'Database probe failed'
		};
	}
}
