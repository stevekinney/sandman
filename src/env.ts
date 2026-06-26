import { defineEnvVars } from '@sveltejs/kit/hooks';

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' }
});
