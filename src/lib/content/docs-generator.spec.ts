/**
 * docs-generator.spec.ts — tests for the README demo-script section generator.
 *
 * Runs in the "server" vitest project (node environment).
 * The generator renders a markdown section from demo-script.ts data.
 * The --check mode verifies an existing section matches the generated output.
 */

import { describe, expect, it } from 'vitest';
import { FEATURE_MAP, TOUR } from './demo-script';
import { generateDemoSection, checkDemoSection } from './docs-generator';

describe('generateDemoSection', () => {
	it('returns a non-empty markdown string', () => {
		const output = generateDemoSection();
		expect(output.length).toBeGreaterThan(0);
	});

	it('includes a heading', () => {
		const output = generateDemoSection();
		expect(output).toMatch(/^##/m);
	});

	it('includes one row per FEATURE_MAP entry', () => {
		const output = generateDemoSection();
		for (const entry of Object.values(FEATURE_MAP)) {
			expect(output, `entry "${entry.concept}" missing from generated section`).toContain(
				entry.concept
			);
		}
	});

	it('includes every TOUR step title', () => {
		const output = generateDemoSection();
		for (const step of TOUR) {
			expect(output, `step "${step.title}" missing from generated section`).toContain(step.title);
		}
	});
});

describe('checkDemoSection', () => {
	it('returns { ok: true } when the section matches generated output', () => {
		const generated = generateDemoSection();
		const result = checkDemoSection(generated);
		expect(result.ok).toBe(true);
	});

	it('returns { ok: false, diff: string } when the section drifts from generated output', () => {
		const stale = '## Demo Script\n\nThis is old and wrong.\n';
		const result = checkDemoSection(stale);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diff.length).toBeGreaterThan(0);
		}
	});
});
