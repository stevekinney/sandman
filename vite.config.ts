import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},

			adapter: adapter(),

			experimental: {
				remoteFunctions: true,
				handleRenderingErrors: true,
				forkPreloads: true
			},
			typescript: {
				config: (config) => ({
					...config,
					include: [...config.include, '../drizzle.config.ts']
				})
			}
		})
	],
	// @lostgradient/cinder ships uncompiled Svelte source (including `.svelte.ts`
	// utilities such as `use-reduced-motion.svelte.ts` that use `export type`).
	// Vite's dependency optimizer pre-bundles deps with Rolldown, whose Svelte
	// parser cannot handle TS `export type` and throws `js_parse_error`. Excluding
	// the library from pre-bundling routes its modules through the normal
	// vite-plugin-svelte transform (which strips TS first), fixing the dev/test
	// optimizer crash that otherwise blocks importing `RunStepTimeline`.
	// Upstream packaging bug: https://github.com/stevekinney/cinder/issues/534
	optimizeDeps: {
		exclude: ['@lostgradient/cinder']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
