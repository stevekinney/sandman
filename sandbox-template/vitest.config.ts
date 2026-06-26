import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest configuration for sandbox-template workflow tests.
 * Uses a plain node environment — does NOT extend the root SvelteKit/Vite config
 * so the SvelteKit plugin, browser runner, and async-experimental flags are absent.
 *
 * Track D adds workflow specs here. Until then, --passWithNoTests prevents
 * the `test:workflows` gate from failing on an empty suite.
 */
export default defineConfig({
	test: {
		name: 'sandbox-template',
		environment: 'node',
		include: ['**/*.{test,spec}.{js,ts}'],
		expect: { requireAssertions: true }
	}
});
