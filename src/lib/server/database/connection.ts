import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.ts';

export type Database = ReturnType<typeof createDatabase>;

let cachedDatabase: { databaseUrl: string; database: Database } | undefined;

export function createDatabase(databaseUrl: string) {
	const client = neon(databaseUrl);
	return drizzle(client, { schema });
}

export function getDatabase(databaseUrl = process.env.DATABASE_URL): Database {
	if (!databaseUrl) {
		throw new Error('DATABASE_URL is required');
	}

	if (cachedDatabase?.databaseUrl !== databaseUrl) {
		cachedDatabase = { databaseUrl, database: createDatabase(databaseUrl) };
	}

	return cachedDatabase.database;
}

export async function probeDatabase(databaseUrl = process.env.DATABASE_URL): Promise<void> {
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	await createDatabase(databaseUrl).execute(sql`SELECT 1`);
}
