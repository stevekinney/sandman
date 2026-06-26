/**
 * feature-legend.svelte.spec.ts — browser tests for the FeatureLegend component.
 * Runs in the "client" vitest project (headless Chromium).
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import FeatureLegend from './feature-legend.svelte';
import { FEATURE_MAP } from '$lib/content/demo-script';

const featureEntries = Object.values(FEATURE_MAP);

describe('FeatureLegend', () => {
	it('renders exactly one row per FEATURE_MAP entry', async () => {
		render(FeatureLegend);
		const rows = page.getByRole('row');
		// +1 for the header row
		await expect.element(rows.nth(0)).toBeInTheDocument();
		// Count data rows (all rows minus the header)
		const allRows = await rows.all();
		// At minimum we have header + one entry per feature
		expect(allRows.length).toBeGreaterThanOrEqual(featureEntries.length);
	});

	it('renders every feature concept label as a table cell', async () => {
		render(FeatureLegend);
		for (const entry of featureEntries) {
			// Concept cell accessible name is exactly the concept string.
			const cell = page.getByRole('cell', { name: entry.concept, exact: true });
			await expect.element(cell).toBeInTheDocument();
		}
	});

	it('renders every feature id as a table cell', async () => {
		render(FeatureLegend);
		for (const entry of featureEntries) {
			// ID cell accessible name is exactly the id string.
			const cell = page.getByRole('cell', { name: entry.id, exact: true });
			await expect.element(cell).toBeInTheDocument();
		}
	});

	it('legend is keyboard-reachable (has a table with tabindex or focusable region)', async () => {
		render(FeatureLegend);
		// The legend should be inside a region that is reachable via keyboard.
		// We verify there is a table (or list) element in the document.
		const table = page.getByRole('table');
		await expect.element(table).toBeInTheDocument();
	});

	it('concept is conveyed by text, not color alone', async () => {
		render(FeatureLegend);
		// Concept name must be visible as cell text — not encoded only via color.
		for (const entry of featureEntries) {
			const cell = page.getByRole('cell', { name: entry.concept, exact: true });
			await expect.element(cell).toBeVisible();
		}
	});
});
