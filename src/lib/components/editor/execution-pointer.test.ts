/**
 * execution-pointer.test.ts — unit tests for anchor resolution and captions.
 */
import { describe, expect, it } from 'vitest';
import {
	executionCaption,
	executionMarker,
	findAnchorLine,
	type ExecutionPointer
} from './execution-pointer';

const SOURCE = ['const a = 1;', 'const b = 2;', 'await condition(() => ready);', 'done();'].join(
	'\n'
);

function pointer(state: ExecutionPointer['state']): ExecutionPointer {
	return {
		file: 'workflows.ts',
		anchor: 'await condition(',
		label: 'parked on condition()',
		state
	};
}

describe('findAnchorLine', () => {
	it('returns the 1-based line of the first match', () => {
		expect(findAnchorLine(SOURCE, 'await condition(')).toBe(3);
		expect(findAnchorLine(SOURCE, 'const a')).toBe(1);
	});

	it('returns null when the anchor was edited away', () => {
		expect(findAnchorLine(SOURCE, 'no such code')).toBeNull();
	});

	it('follows the anchor as lines are inserted above it', () => {
		const edited = `// a new comment\n${SOURCE}`;
		expect(findAnchorLine(edited, 'await condition(')).toBe(4);
	});
});

describe('executionCaption', () => {
	it('describes a running pointer with its label', () => {
		expect(executionCaption(pointer('running'), 3, true)).toBe(
			'Executing line 3 — parked on condition()'
		);
	});

	it('names the file when the pointer is not in the active file', () => {
		expect(executionCaption(pointer('running'), 3, false)).toContain('workflows.ts line 3');
	});

	it('explains the paused and replaying states', () => {
		expect(executionCaption(pointer('paused'), 3, true)).toContain('worker offline');
		expect(executionCaption(pointer('replaying'), 3, true)).toContain('Replaying history');
	});
});

describe('executionMarker', () => {
	it('maps states to distinct glyphs', () => {
		expect(
			new Set([executionMarker('running'), executionMarker('paused'), executionMarker('replaying')])
				.size
		).toBe(3);
	});
});
