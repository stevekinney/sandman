/**
 * file-descriptors.test.ts — unit tests for the editor file descriptor list.
 * Runs in the "server" vitest project (node environment).
 */

import { describe, expect, it } from 'vitest';
import { FILE_DESCRIPTORS, SHARED_FILE_NAME } from './file-descriptors.ts';

describe('FILE_DESCRIPTORS', () => {
	it('contains exactly four files', () => {
		expect(FILE_DESCRIPTORS).toHaveLength(4);
	});

	it('includes workflows.ts, activities.ts, worker.ts, and shared.ts', () => {
		const names = FILE_DESCRIPTORS.map((f) => f.name);
		expect(names).toContain('workflows.ts');
		expect(names).toContain('activities.ts');
		expect(names).toContain('worker.ts');
		expect(names).toContain('shared.ts');
	});

	it('shared.ts is readOnly', () => {
		const shared = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		expect(shared).toBeDefined();
		expect(shared?.readOnly).toBe(true);
	});

	it('workflows.ts, activities.ts, and worker.ts are NOT readOnly', () => {
		const editables = FILE_DESCRIPTORS.filter((f) => f.name !== SHARED_FILE_NAME);
		expect(editables).toHaveLength(3);
		for (const f of editables) {
			expect(f.readOnly, `${f.name} should not be readOnly`).toBe(false);
		}
	});

	it('each descriptor has a name, language, and initialContents string', () => {
		for (const f of FILE_DESCRIPTORS) {
			expect(typeof f.name, 'name').toBe('string');
			expect(typeof f.language, 'language').toBe('string');
			expect(typeof f.initialContents, 'initialContents').toBe('string');
		}
	});

	it('each language is typescript', () => {
		for (const f of FILE_DESCRIPTORS) {
			expect(f.language).toBe('typescript');
		}
	});
});
