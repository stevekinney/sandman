import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

export default defineConfig({
	schema: './src/lib/server/database/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: databaseUrl ?? 'postgres://user:password@localhost:5432/sandman'
	},
	verbose: true,
	strict: true
});
