/**
 * file-descriptors.test.ts — unit tests for the editor file descriptor list.
 * Runs in the "server" vitest project (node environment).
 */

import { describe, expect, it } from 'vitest';
import { FILE_DESCRIPTORS, SHARED_FILE_NAME } from './file-descriptors.ts';

describe('FILE_DESCRIPTORS', () => {
	it('contains exactly five files', () => {
		expect(FILE_DESCRIPTORS).toHaveLength(5);
	});

	it('includes workflows.ts, signals.ts, activities.ts, worker.ts, and shared.ts', () => {
		const names = FILE_DESCRIPTORS.map((f) => f.name);
		expect(names).toContain('workflows.ts');
		expect(names).toContain('signals.ts');
		expect(names).toContain('activities.ts');
		expect(names).toContain('worker.ts');
		expect(names).toContain('shared.ts');
	});

	it('shared.ts and signals.ts are readOnly', () => {
		const shared = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		const signals = FILE_DESCRIPTORS.find((f) => f.name === 'signals.ts');
		expect(shared).toBeDefined();
		expect(signals).toBeDefined();
		expect(shared?.readOnly).toBe(true);
		expect(signals?.readOnly).toBe(true);
	});

	it('workflows.ts, activities.ts, and worker.ts are NOT readOnly', () => {
		const editables = FILE_DESCRIPTORS.filter((f) =>
			['workflows.ts', 'activities.ts', 'worker.ts'].includes(f.name)
		);
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

describe('FILE_DESCRIPTORS — contents reflect the real deployed sandbox-template files', () => {
	it('workflows.ts initialContents uses the real camelCase export name orderFoodWorkflow', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'workflows.ts');
		expect(descriptor).toBeDefined();
		// The deployed sandbox-template/workflows.ts uses `orderFoodWorkflow` (camelCase).
		// The old hand-written stub used `OrderFoodWorkflow` (PascalCase). This
		// assertion is red on the stub and green on the real file.
		expect(descriptor?.initialContents).toContain('orderFoodWorkflow');
	});

	it('workflows.ts initialContents is substantially longer than the ~70-line stub', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'workflows.ts');
		expect(descriptor).toBeDefined();
		// The real file is ~870 lines. The stub was ~70 lines. Any value over 200
		// lines distinguishes the two unambiguously.
		const lineCount = (descriptor?.initialContents ?? '').split('\n').length;
		expect(lineCount).toBeGreaterThan(200);
	});

	it('signals.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'signals.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('defineSignal<[CancelOrderSignal]>');
	});

	it('activities.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'activities.ts');
		expect(descriptor).toBeDefined();
		// The real activities.ts imports Context heartbeat and uses it.
		// The stub comment said "replace with your real provider" — use the absence
		// of that stub-only phrase as the discriminator.
		expect(descriptor?.initialContents).not.toContain('replace with your real provider');
	});

	it('shared.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		expect(descriptor).toBeDefined();
		// The real shared.ts does not re-export from a non-existent ./workflow-api-types
		// module — the stub had a bogus `export type ... from './workflow-api-types'` line.
		expect(descriptor?.initialContents).not.toContain('./workflow-api-types');
	});
});
