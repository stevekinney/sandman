import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sessionPageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('session skip link', () => {
	it('uses the Cinder SkipLink component for the guided journey target', () => {
		expect(sessionPageSource).toContain("import SkipLink from '@lostgradient/cinder/skip-link';");
		expect(sessionPageSource).toContain('<SkipLink target="guided-journey">');
		expect(sessionPageSource).toContain('Skip to guided journey');
	});

	it('does not keep bespoke skip-link markup or component-owned CSS', () => {
		expect(sessionPageSource).not.toContain('class="skip-link"');
		expect(sessionPageSource).not.toContain('.skip-link');
	});
});
