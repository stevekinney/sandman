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
	// Still unresolved in @lostgradient/cinder@0.4.1 (browser export condition
	// still points to ./src/index.ts uncompiled source).
	optimizeDeps: {
		exclude: ['@lostgradient/cinder']
	},
	// Cinder's export maps list the `node` condition before `svelte`, so SSR
	// resolves to `./dist/server/*` — precompiled without Svelte's dev-mode
	// metadata. Rendering app-authored snippets through those components (e.g.
	// children of `ToastRegion`) crashes dev SSR in `push_element` ("Cannot
	// read properties of undefined (reading 'Symbol(filename)')"). Bundling
	// cinder into the SSR build and dropping `node` from the SSR condition set
	// resolves the `svelte` condition instead, so SSR compiles the same source
	// the browser uses. Fixed upstream (stevekinney/cinder#575) but not yet
	// released as of @lostgradient/cinder@0.4.1 — remove once a release ships.
	ssr: {
		// lucide-svelte ships raw .svelte files that Node cannot import when
		// externalized — it must ride through the Svelte transform with cinder
		// (stevekinney/cinder#533 documents the same pairing).
		noExternal: ['@lostgradient/cinder', 'lucide-svelte'],
		resolve: {
			conditions: ['svelte', 'module', 'development|production']
		}
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
					include: ['src/**/*.{test,spec}.{js,ts}', 'eslint-rules/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
