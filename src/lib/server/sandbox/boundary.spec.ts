/**
 * boundary.spec.ts — asserts this module is server-only.
 *
 * Runs in the "server" vitest project (node environment).
 * SvelteKit treats everything under src/lib/server/ as server-only at build
 * time; this test provides a runtime signal that the import path is correct
 * and the public API is exportable.
 */

import { describe, it, expect } from 'vitest';
import * as indexExports from './index.ts';

describe('server-only boundary', () => {
	it('module URL contains /server/ — proving it is in the server-only tree', () => {
		// import.meta.url reflects the file's actual path on disk.
		expect(import.meta.url).toContain('/server/');
	});

	it('createSandboxClient is exported as a function', () => {
		expect(typeof indexExports.createSandboxClient).toBe('function');
	});

	it('createRealE2bAdapter is exported as a function', () => {
		expect(typeof indexExports.createRealE2bAdapter).toBe('function');
	});

	it('createReaper is exported as a function', () => {
		expect(typeof indexExports.createReaper).toBe('function');
	});
});
