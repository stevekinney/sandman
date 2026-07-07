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

	it('includes workflow, activities, worker, and shared, in that order', () => {
		const names = FILE_DESCRIPTORS.map((f) => f.name);
		expect(names).toEqual(['workflow.ts', 'activities.ts', 'worker.ts', 'shared.ts']);
	});

	it('the workflow is the default (first) tab', () => {
		expect(FILE_DESCRIPTORS[0].name).toBe('workflow.ts');
	});

	it('only shared.ts is readOnly', () => {
		const shared = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		expect(shared).toBeDefined();
		expect(shared?.readOnly).toBe(true);
	});

	it('workflow, activities, and worker files are NOT readOnly', () => {
		const editables = FILE_DESCRIPTORS.filter((f) =>
			['workflow.ts', 'activities.ts', 'worker.ts'].includes(f.name)
		);
		expect(editables).toHaveLength(3);
		for (const f of editables) {
			expect(f.readOnly, `${f.name} should not be readOnly`).toBe(false);
		}
	});

	it('each descriptor has a name, purpose, language, and initialContents string', () => {
		for (const f of FILE_DESCRIPTORS) {
			expect(typeof f.name, 'name').toBe('string');
			expect(typeof f.purpose, 'purpose').toBe('string');
			expect(f.purpose.length, `${f.name} purpose`).toBeGreaterThan(0);
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

describe('FILE_DESCRIPTORS — contents reflect the real deployed sandbox-template files', () => {
	it('workflow.ts initialContents defines the real orderWorkflow', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'workflow.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('export async function orderWorkflow(');
	});

	it('activities.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'activities.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('export async function chargePayment(');
	});

	it('worker.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'worker.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents.length).toBeGreaterThan(0);
	});

	it('shared.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('export type OrderInput');
	});
});
