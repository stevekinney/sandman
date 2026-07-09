import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const segmentedControlFiles = [
	new URL('./history-rail.svelte', import.meta.url),
	new URL('./control-toolbar.svelte', import.meta.url)
] as const;

describe('control plane segmented controls', () => {
	it('use Cinder primitives instead of hand-rolled tab markup', async () => {
		for (const fileUrl of segmentedControlFiles) {
			const source = await readFile(fileUrl, 'utf8');

			expect(source).toContain("from '@lostgradient/cinder/segmented-control'");
			expect(source).toContain("from '@lostgradient/cinder/segment'");
			expect(source).toMatch(/<SegmentedControl[\s\S]*?\s+hideLabel[\s\S]*?>/);
			expect(source).not.toMatch(/handle[A-Za-z]+TabKeydown/);
			expect(source).not.toMatch(/focus[A-Za-z]+Tab/);
			expect(source).not.toContain('class="cinder-tab');
			expect(source).not.toContain('data-cinder-active');
		}
	});
});
