import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required for Drizzle migrations');
}

export default defineConfig({
	schema: './src/lib/server/database/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: databaseUrl
	},
	verbose: true,
	strict: true
});
