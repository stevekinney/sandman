/**
 * docs-generator.ts — generates (and drift-checks) the README "Demo script" section
 * from the authoritative demo-script.ts data.
 *
 * Usage as a runnable module (via bun):
 *   bun src/lib/content/docs-generator.ts           → print generated section
 *   bun src/lib/content/docs-generator.ts --check   → exit 1 if README drifts
 */

import { FEATURE_MAP, TOUR } from './demo-script';

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

/**
 * Generates the markdown "Demo Script" section from the live demo-script.ts data.
 * The output is deterministic — the same data always produces the same string.
 */
export function generateDemoSection(): string {
	const lines: string[] = [];

	lines.push('## Demo Script');
	lines.push('');
	lines.push(
		'Sandman demonstrates the following Temporal features through a deliberately over-engineered food-ordering workflow.'
	);
	lines.push('');

	// Feature legend
	lines.push('### Feature Legend');
	lines.push('');
	lines.push('| Feature | Concept | How it is demonstrated |');
	lines.push('| ------- | ------- | ---------------------- |');

	for (const entry of Object.values(FEATURE_MAP)) {
		const id = entry.id;
		const concept = entry.concept;
		const mechanic = entry.mechanic.replace(/\|/g, '\\|').replace(/\n/g, ' ');
		const control = entry.control ? `\`${entry.control}\`` : '—';
		lines.push(`| ${id} | **${concept}** (${control}) | ${mechanic} |`);
	}

	lines.push('');

	// Guided tour
	lines.push('### Guided Tour');
	lines.push('');
	lines.push(
		'The tour advances step-by-step as real Temporal workflow events arrive — not on button clicks.'
	);
	lines.push('');

	for (let i = 0; i < TOUR.length; i++) {
		const step = TOUR[i];
		const num = i + 1;
		const control = step.control ? ` (control: \`${step.control}\`)` : '';
		lines.push(`${num}. **${step.title}**${control}`);
		lines.push(`   ${step.instruction}`);
		lines.push('');
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

/** Result type for `checkDemoSection`. */
export type CheckResult = { ok: true } | { ok: false; diff: string };

/**
 * Compares `existing` content against the freshly-generated section.
 *
 * @returns `{ ok: true }` when they match, `{ ok: false, diff }` when they drift.
 */
export function checkDemoSection(existing: string): CheckResult {
	const generated = generateDemoSection();
	if (existing === generated) {
		return { ok: true };
	}
	const diff = diffLines(existing, generated);
	return { ok: false, diff };
}

/** Produce a minimal unified-diff style string between two multi-line texts. */
function diffLines(a: string, b: string): string {
	const aLines = a.split('\n');
	const bLines = b.split('\n');
	const out: string[] = ['--- existing', '+++ generated'];

	const maxLen = Math.max(aLines.length, bLines.length);
	for (let i = 0; i < maxLen; i++) {
		const aLine = aLines[i];
		const bLine = bLines[i];
		if (aLine !== bLine) {
			if (aLine !== undefined) out.push(`- ${aLine}`);
			if (bLine !== undefined) out.push(`+ ${bLine}`);
		}
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry-point (run with: bun src/lib/content/docs-generator.ts [--check])
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const checkMode = args.includes('--check');

	if (checkMode) {
		// Read the README and extract the demo section.
		const { readFileSync } = await import('node:fs');
		const { resolve, dirname } = await import('node:path');
		const { fileURLToPath } = await import('node:url');

		// The file lives at src/lib/content/docs-generator.ts — three levels
		// up from this directory reaches the project root.
		const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
		let readmeContent: string;
		try {
			readmeContent = readFileSync(resolve(rootDir, 'README.md'), 'utf8');
		} catch {
			console.error('README.md not found — cannot check drift.');
			process.exit(1);
		}

		// Extract the "## Demo Script" section (up to the next ## heading or end of file).
		// Note: JS has no \z (end-of-string anchor); (?![\s\S]) is a negative lookahead
		// that is only satisfiable at end-of-string.
		const sectionMatch = /## Demo Script\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(readmeContent);
		const existingSection = sectionMatch ? sectionMatch[0] : '';

		const result = checkDemoSection(existingSection);
		if (result.ok) {
			process.stdout.write('Demo script section is up to date.\n');
			process.exit(0);
		} else {
			process.stderr.write('Demo script section has drifted from demo-script.ts:\n\n');
			process.stderr.write(result.diff + '\n');
			process.exit(1);
		}
	} else {
		// generateDemoSection() already ends with a trailing newline from the
		// empty string appended after the last tour step. Do not add a second
		// newline here or the check mode will see a spurious blank line diff.
		process.stdout.write(generateDemoSection());
	}
}
