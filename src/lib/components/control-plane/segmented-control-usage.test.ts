import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const segmentedControlFiles = [
	'src/lib/components/control-plane/history-rail.svelte',
	'src/lib/components/control-plane/control-toolbar.svelte'
] as const;

describe('control plane segmented controls', () => {
	it('use Cinder primitives instead of hand-rolled tab markup', async () => {
		for (const filePath of segmentedControlFiles) {
			const source = await readFile(filePath, 'utf8');

			expect(source).toContain("from '@lostgradient/cinder/segmented-control'");
			expect(source).toContain("from '@lostgradient/cinder/segment'");
			expect(source).not.toMatch(/handle[A-Za-z]+TabKeydown/);
			expect(source).not.toMatch(/focus[A-Za-z]+Tab/);
			expect(source).not.toContain('class="cinder-tab');
			expect(source).not.toContain('data-cinder-active');
		}
	});
});
