import { afterEach, describe, expect, it, vi } from 'vitest';

const configuredDatabaseUrl = 'postgresql://user:password@example.com/sandman';
const neon = vi.fn(() => ({}));
const drizzle = vi.fn(() => ({ execute: vi.fn() }));

vi.mock('$lib/server/configuration', () => ({
	getProductionConfiguration: vi.fn(() => ({ databaseUrl: configuredDatabaseUrl }))
}));

vi.mock('@neondatabase/serverless', () => ({ neon }));
vi.mock('drizzle-orm/neon-http', () => ({ drizzle }));

describe('getDatabase', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('uses the loaded Sandman configuration when no explicit URL is provided', async () => {
		const { getDatabase } = await import('./connection.ts');

		getDatabase();

		expect(neon).toHaveBeenCalledWith(configuredDatabaseUrl);
		expect(drizzle).toHaveBeenCalledOnce();
	});
});
