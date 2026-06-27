/**
 * determinism-guard.test.ts — unit tests for the Temporal determinism diagnostic provider.
 * Runs in the "server" vitest project (node environment).
 *
 * Tests the pure getDeterminismMarkers function with no real Monaco DOM needed.
 *
 * The guard teaches the *real* TS determinism model: Date/Math.random/setTimeout
 * are SDK-patched and replay-safe (flagged Info), while network I/O, Web Crypto
 * randomness, non-durable timers, and Node wall-clock genuinely break determinism
 * (flagged Warning).
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

describe('getDeterminismMarkers — SDK-patched calls are flagged Info (replay-safe)', () => {
	it('flags Date.now() as an informational, replay-safe note', () => {
		const markers = getDeterminismMarkers('const t = Date.now();', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Info);
		expect(markers[0].message).toContain('replay-safe');
	});

	it('flags new Date() as an informational, replay-safe note', () => {
		const markers = getDeterminismMarkers('const d = new Date();', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Info);
		expect(markers[0].message).toContain('replay-safe');
	});

	it('flags Math.random() as an informational, replay-safe note', () => {
		const markers = getDeterminismMarkers('const n = Math.random();', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Info);
		expect(markers[0].message).toContain('replay-safe');
	});

	it('flags setTimeout() as Info and recommends sleep()', () => {
		const markers = getDeterminismMarkers('setTimeout(() => {}, 100);', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Info);
		expect(markers[0].message).toContain('sleep()');
	});

	it('does NOT claim patched calls return a different value on replay', () => {
		const markers = getDeterminismMarkers('const t = Date.now();', 'workflows.ts');
		// The old, false message claimed replay would differ and pointed at a
		// non-existent workflow.now(). Guard against that regression.
		expect(markers[0].message).not.toContain('different value on replay');
		expect(markers[0].message).not.toContain('workflow.now()');
	});
});

describe('getDeterminismMarkers — genuinely unsafe calls are flagged Warning', () => {
	it('flags fetch() as a determinism Warning pointing to activities', () => {
		const markers = getDeterminismMarkers("await fetch('https://example.com');", 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
		expect(markers[0].message).toContain('activity');
	});

	it('flags crypto.randomUUID() as a Warning recommending uuid4()', () => {
		const markers = getDeterminismMarkers('const id = crypto.randomUUID();', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
		expect(markers[0].message).toContain('uuid4()');
	});

	it('flags crypto.getRandomValues() as a Warning (Web Crypto is not patched)', () => {
		const markers = getDeterminismMarkers(
			'crypto.getRandomValues(new Uint8Array(4));',
			'workflows.ts'
		);
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
		expect(markers[0].message).toContain('Web Crypto');
	});

	it('flags setInterval() as a Warning recommending a sleep() loop', () => {
		const markers = getDeterminismMarkers('setInterval(() => {}, 100);', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
		expect(markers[0].message).toContain('sleep()');
	});

	it('flags process.hrtime as a Warning', () => {
		const markers = getDeterminismMarkers('const t = process.hrtime();', 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe(MARKER_SEVERITY.Warning);
		expect(markers[0].message).toContain('wall-clock');
	});
});

describe('getDeterminismMarkers — positioning and clean code', () => {
	it('reports correct line numbers (1-based)', () => {
		const code = [
			'import { defineSignal } from "@temporalio/workflow";',
			'const t = Date.now();'
		].join('\n');
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].startLineNumber).toBe(2);
	});

	it('returns an empty array for clean workflow code', () => {
		const code = [
			"import { defineQuery, condition, sleep, uuid4 } from '@temporalio/workflow';",
			'export async function OrderWorkflow() {',
			'  const id = uuid4();',
			'  await sleep("1h");',
			'  await condition(() => false);',
			'  return id;',
			'}'
		].join('\n');
		const markers = getDeterminismMarkers(code, 'workflows.ts');
		expect(markers).toHaveLength(0);
	});
});

describe('getDeterminismMarkers — non-workflow files are exempt (IO allowed)', () => {
	it('does NOT flag Date.now() in activities.ts', () => {
		expect(getDeterminismMarkers('const t = Date.now();', 'activities.ts')).toHaveLength(0);
	});

	it('does NOT flag fetch() in activities.ts', () => {
		expect(
			getDeterminismMarkers("await fetch('https://example.com');", 'activities.ts')
		).toHaveLength(0);
	});

	it('does NOT flag crypto.randomUUID() in activities.ts', () => {
		expect(getDeterminismMarkers('crypto.randomUUID();', 'activities.ts')).toHaveLength(0);
	});

	it('does NOT flag Date.now() in worker.ts', () => {
		expect(getDeterminismMarkers('const t = Date.now();', 'worker.ts')).toHaveLength(0);
	});
});
