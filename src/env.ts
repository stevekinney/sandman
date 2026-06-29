import { defineEnvVars } from '@sveltejs/kit/hooks';

// Sandman accesses E2B credentials via process.env directly (server-only), so no
// $env-validated variables are declared here. Kept as the SvelteKit env-vars
// convention file.
export const variables = defineEnvVars({});
