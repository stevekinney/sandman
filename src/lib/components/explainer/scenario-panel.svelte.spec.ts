/**
 * scenario-panel.svelte.spec.ts — browser tests for ScenarioPanel.
 * Runs in the "client" vitest project (headless Chromium).
 * Table-driven over every OrderStatus value.
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ScenarioPanel from './scenario-panel.svelte';
import { ORDER_STATUS } from '$lib/contracts/workflow-api';
import type { OrderStatus } from '$lib/contracts/workflow-api';
import { SCENARIO_COPY } from '$lib/content/demo-script';

const statusCases: Array<[OrderStatus, string]> = Object.entries(ORDER_STATUS).map(([, v]) => [
	v as OrderStatus,
	SCENARIO_COPY[v as OrderStatus]
]);

describe('ScenarioPanel', () => {
	it('renders a region / landmark for the scenario description', async () => {
		const [status] = statusCases[0];
		render(ScenarioPanel, { props: { status } });
		const region = page.getByRole('region');
		await expect.element(region).toBeInTheDocument();
	});

	for (const [status, expectedCopy] of statusCases) {
		it(`renders the correct copy for status "${status}"`, async () => {
			render(ScenarioPanel, { props: { status } });
			await expect.element(page.getByText(expectedCopy, { exact: false })).toBeInTheDocument();
		});
	}

	it('renders the order status text so it is visible (not color-only)', async () => {
		const [status] = statusCases[0];
		render(ScenarioPanel, { props: { status } });
		// The status string itself must appear as readable text
		await expect.element(page.getByText(status, { exact: false })).toBeVisible();
	});
});
