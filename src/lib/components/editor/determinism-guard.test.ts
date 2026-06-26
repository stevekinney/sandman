/**
 * determinism-guard.test.ts — unit tests for the Temporal determinism diagnostic provider.
 * Runs in the "server" vitest project (node environment).
 *
 * Tests the pure getDeterminismMarkers function with no real Monaco DOM needed.
 */

import { describe, expect, it } from 'vitest';
import { getDeterminismMarkers, isWorkflowFile, MARKER_SEVERITY } from './determinism-guard.ts';

describe('isWorkflowFile', () => {
	it('returns true for workflows.ts', () => {
		expect(isWorkflowFile('workflows.ts')).toBe(true);
	});

	it('returns true for a full path ending in workflows.ts', () => {
		expect(isWorkflowFile('/sandbox/src/workflows.ts')).toBe(true);
	});

	it('returns false for activities.ts', () => {
		expect(isWorkflowFile('activities.ts')).toBe(false);
	});

	it('returns false for worker.ts', () => {
		expect(isWorkflowFile('worker.ts')).toBe(false);
	});

	it('returns false for shared.ts', () => {
		expect(isWorkflowFile('shared.ts')).toBe(false);
	});
});

describe('getDeterminismMarkers — workflows.ts path', () => {
	it('flags Date.now() usage', () => {
		const code = 'const t = Date.now();';
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].message).toContain('determinism');
	});

	it('flags Math.random() usage', () => {
		const code = 'const n = Math.random();';
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].message).toContain('determinism');
	});

	it('flags fetch() usage', () => {
		const code = "const res = await fetch('https://example.com');";
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].message).toContain('determinism');
	});

	it('flags new Date() usage', () => {
		const code = 'const d = new Date();';
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].message).toContain('determinism');
	});

	it('reports correct line numbers (1-based)', () => {
		const code = [
			'import { defineSignal } from "@temporalio/workflow";',
			'const t = Date.now();'
		].join('\n');
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].startLineNumber).toBe(2);
	});

	it('uses Warning severity', () => {
		const code = 'const t = Date.now();';
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
	});

	it('returns empty array for clean workflow code', () => {
		const code = [
			"import { defineQuery, condition } from '@temporalio/workflow';",
			'export async function OrderWorkflow() {',
			'  await condition(() => false);',
			'}'
		].join('\n');
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers).toHaveLength(0);
	});
});

describe('getDeterminismMarkers — activities.ts path (IO allowed)', () => {
	it('does NOT flag Date.now() in activities.ts', () => {
		const code = 'const t = Date.now();';
		const markers = getDeterminismMarkers(code, 'activities.ts');
		expect(markers).toHaveLength(0);
	});

	it('does NOT flag Math.random() in activities.ts', () => {
		const code = 'const n = Math.random();';
		const markers = getDeterminismMarkers(code, 'activities.ts');
		expect(markers).toHaveLength(0);
	});

	it('does NOT flag fetch() in activities.ts', () => {
		const code = "const res = await fetch('https://example.com');";
		const markers = getDeterminismMarkers(code, 'activities.ts');
		expect(markers).toHaveLength(0);
	});
});

describe('getDeterminismMarkers — worker.ts path (IO allowed)', () => {
	it('does NOT flag Date.now() in worker.ts', () => {
		const code = 'const t = Date.now();';
		const markers = getDeterminismMarkers(code, 'worker.ts');
		expect(markers).toHaveLength(0);
	});
});
