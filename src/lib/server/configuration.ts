import { loadEnv } from 'vite';

const DEFAULT_SESSION_TTL_MS = 300_000;
const DEFAULT_MAX_ACTIVE_SANDBOXES = 20;
const DEFAULT_MAX_ACTIVE_SANDBOXES_PER_SESSION = 1;
const DEFAULT_SESSION_CREATIONS_PER_TOKEN_PER_HOUR = 5;

export type ProductionConfiguration = {
	databaseUrl: string | undefined;
	e2bApiKey: string | undefined;
	e2bTemplateId: string | undefined;
	demoTokenHash: string | undefined;
	sessionSecret: string | undefined;
	sessionTtlMs: number;
	maxActiveSandboxes: number;
	maxActiveSandboxesPerSession: number;
	sessionCreationsPerTokenPerHour: number;
	isProduction: boolean;
};

type Environment = Record<string, string | undefined>;

let cachedLocalEnvironment: Environment | undefined;

export function getProductionConfiguration(
	environment: Environment = getDefaultEnvironment()
): ProductionConfiguration {
	return {
		databaseUrl: environment.DATABASE_URL,
		e2bApiKey: environment.E2B_API_KEY,
		e2bTemplateId: environment.E2B_TEMPLATE_ID,
		demoTokenHash: environment.SANDMAN_DEMO_TOKEN_SHA256,
		sessionSecret: environment.SANDMAN_SESSION_SECRET,
		sessionTtlMs: readPositiveInteger(environment.SANDMAN_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
		maxActiveSandboxes: readPositiveInteger(
			environment.SANDMAN_MAX_ACTIVE_SANDBOXES,
			DEFAULT_MAX_ACTIVE_SANDBOXES
		),
		maxActiveSandboxesPerSession: readPositiveInteger(
			environment.SANDMAN_MAX_ACTIVE_SANDBOXES_PER_SESSION,
			DEFAULT_MAX_ACTIVE_SANDBOXES_PER_SESSION
		),
		sessionCreationsPerTokenPerHour: readPositiveInteger(
			environment.SANDMAN_SESSION_CREATIONS_PER_TOKEN_PER_HOUR,
			DEFAULT_SESSION_CREATIONS_PER_TOKEN_PER_HOUR
		),
		isProduction: environment.NODE_ENV === 'production'
	};
}

function getDefaultEnvironment(): Environment {
	const localEnvironment = getLocalEnvironment();
	return { ...localEnvironment, ...process.env };
}

function getLocalEnvironment(): Environment {
	cachedLocalEnvironment ??= loadEnv(getEnvironmentMode(), process.cwd(), '');
	return cachedLocalEnvironment;
}

function getEnvironmentMode(): string {
	return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function requireProductionReadiness(configuration = getProductionConfiguration()): void {
	const missing = getMissingProductionRequirements(configuration);
	if (missing.length > 0) {
		throw new Error(`Missing production configuration: ${missing.join(', ')}`);
	}
}

export function getMissingProductionRequirements(
	configuration = getProductionConfiguration()
): string[] {
	const missing: string[] = [];
	if (!configuration.databaseUrl) missing.push('DATABASE_URL');
	if (!configuration.e2bApiKey) missing.push('E2B_API_KEY');
	if (!configuration.demoTokenHash) missing.push('SANDMAN_DEMO_TOKEN_SHA256');
	if (!configuration.sessionSecret) missing.push('SANDMAN_SESSION_SECRET');
	if (configuration.isProduction && !configuration.e2bTemplateId) missing.push('E2B_TEMPLATE_ID');
	return missing;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}
