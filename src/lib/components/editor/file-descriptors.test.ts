/**
 * file-descriptors.test.ts — unit tests for the editor file descriptor list.
 * Runs in the "server" vitest project (node environment).
 */

import { describe, expect, it } from 'vitest';
import { FILE_DESCRIPTORS, SHARED_FILE_NAME } from './file-descriptors.ts';

describe('FILE_DESCRIPTORS', () => {
	it('contains exactly seven files', () => {
		expect(FILE_DESCRIPTORS).toHaveLength(7);
	});

	it('includes the split workflow files plus signals, activities, worker, and shared', () => {
		const names = FILE_DESCRIPTORS.map((f) => f.name);
		expect(names).toEqual([
			'order-workflow.ts',
			'delivery-workflow.ts',
			'definitions.ts',
			'activities.ts',
			'signals.ts',
			'worker.ts',
			'shared.ts'
		]);
	});

	it('the main order workflow is the default (first) tab', () => {
		expect(FILE_DESCRIPTORS[0].name).toBe('order-workflow.ts');
	});

	it('shared.ts and signals.ts are readOnly', () => {
		const shared = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		const signals = FILE_DESCRIPTORS.find((f) => f.name === 'signals.ts');
		expect(shared).toBeDefined();
		expect(signals).toBeDefined();
		expect(shared?.readOnly).toBe(true);
		expect(signals?.readOnly).toBe(true);
	});

	it('the workflow, definitions, activities, and worker files are NOT readOnly', () => {
		const editables = FILE_DESCRIPTORS.filter((f) =>
			[
				'order-workflow.ts',
				'delivery-workflow.ts',
				'definitions.ts',
				'activities.ts',
				'worker.ts'
			].includes(f.name)
		);
		expect(editables).toHaveLength(5);
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
	it('order-workflow.ts initialContents defines the real orderFoodWorkflow', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'order-workflow.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('export async function orderFoodWorkflow(');
	});

	it('delivery-workflow.ts initialContents defines the child deliveryWorkflow', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'delivery-workflow.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('export async function deliveryWorkflow(');
	});

	it('definitions.ts initialContents carries the activity retry policy', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'definitions.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('maximumAttempts: 5');
		expect(descriptor?.initialContents).toContain('proxyActivities');
	});

	it('signals.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'signals.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).toContain('defineSignal<[CancelOrderSignal]>');
	});

	it('activities.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === 'activities.ts');
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).not.toContain('replace with your real provider');
	});

	it('shared.ts initialContents comes from the deployed sandbox-template file', () => {
		const descriptor = FILE_DESCRIPTORS.find((f) => f.name === SHARED_FILE_NAME);
		expect(descriptor).toBeDefined();
		expect(descriptor?.initialContents).not.toContain('./workflow-api-types');
	});
});
