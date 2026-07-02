/**
 * sandbox-ui.e2e.ts — end-to-end Playwright tests for the session UI shell.
 *
 * Tests:
 *  - Navigating to /{sessionId} renders the single-screen workbench.
 *  - The Temporal Web UI iframe is present with the correct proxied src path
 *    when the Temporal UI view is selected.
 *  - The code editor is the default center view with Cinder file tabs.
 *  - The guided journey and workflow history rails are present.
 *
 * These tests do NOT require a live E2B sandbox — they verify structure only,
 * and mock the Temporal UI proxy when asserting iframe behavior.
 */

import { expect, test, type Page } from '@playwright/test';

const TEST_SESSION_ID = 'e2e-test-session-iframe';

async function mockReadySandbox(page: Page): Promise<void> {
	await page.route(new RegExp(`/api/sandbox/${TEST_SESSION_ID}/status$`), async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'ready', errorMessage: null })
		});
	});
	await page.route(`**/sbx/${TEST_SESSION_ID}/ui/`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><title>Temporal Web UI</title>'
		});
	});
}

test('session page renders the Sandman heading', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('h1')).toHaveText('Sandman');
});

test('session page shows the sandbox ID in the header', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('.session__id')).toContainText(TEST_SESSION_ID);
});

test('session pages are titled, described, and kept out of search indexes', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);

	await expect(page).toHaveTitle('Temporal sandbox session · Sandman');
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
	await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
		'content',
		/Temporal sandbox session/
	);
});

test('TemporalUiFrame renders an iframe whose src is the proxied path', async ({ page }) => {
	await mockReadySandbox(page);
	await page.goto(`/${TEST_SESSION_ID}`);
	await page.getByRole('tab', { name: 'Temporal UI' }).click();

	// The iframe must be present in the DOM with the correct same-origin proxy src.
	const iframe = page.locator('iframe[title="Temporal Web UI"]');
	await expect(iframe).toBeVisible();

	const src = await iframe.getAttribute('src');
	expect(src).toBe(`/sbx/${TEST_SESSION_ID}/ui/`);
});

test('editor is the default center view with Cinder file tabs', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('#center-panel-code')).toBeVisible();
	await expect(page.locator('.cinder-tabs')).toBeVisible();
	await expect(page.getByRole('tablist', { name: 'Editor files' })).toHaveClass(/cinder-tab-list/);
	await expect(page.getByRole('tab', { name: 'order-workflow.ts' })).toHaveClass(/cinder-tab/);
});

test('guided journey and workflow history rails are rendered', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('[aria-label="Guided journey"]').first()).toBeVisible();
	await expect(page.locator('[aria-label="Workflow history"]')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Tour progress' })).toBeVisible();
});

test('the center view switch exposes Code and Temporal UI as tabs', async ({ page }) => {
	// A usable sandbox is required: unusable sessions render the gate overlay,
	// which intentionally makes the workbench inert.
	await mockReadySandbox(page);
	await page.goto(`/${TEST_SESSION_ID}`);

	const viewSwitch = page.getByRole('tablist', { name: 'Workbench view' });
	await expect(viewSwitch).toBeVisible();
	await expect(viewSwitch.getByRole('tab', { name: 'Code' })).toBeVisible();
	await expect(viewSwitch.getByRole('tab', { name: 'Temporal UI' })).toBeVisible();

	await viewSwitch.getByRole('tab', { name: 'Temporal UI' }).click();
	await expect(page.locator('#center-panel-temporal')).toBeVisible();
	await expect(page.locator('#center-panel-code')).toBeHidden();
});

test('topology strip shows the client, server, and worker nodes', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	const topology = page.locator('[aria-label="System topology"]');
	await expect(topology).toBeVisible();
	await expect(topology).toContainText('Your application');
	await expect(topology).toContainText('Temporal Server');
	await expect(topology).toContainText('Worker');
});

test('the Temporal Server can be stopped and started with persisted state', async ({ page }) => {
	await mockReadySandbox(page);
	await page.route(`**/api/sandbox/${TEST_SESSION_ID}/server/stop`, async (route) => {
		await route.fulfill({ status: 204, body: '' });
	});
	await page.route(`**/api/sandbox/${TEST_SESSION_ID}/server/start`, async (route) => {
		await route.fulfill({ status: 204, body: '' });
	});

	await page.goto(`/${TEST_SESSION_ID}`);
	const topology = page.locator('[aria-label="System topology"]');

	await topology.getByRole('button', { name: 'Stop' }).click();
	await expect(topology).toContainText('stopped · state persisted to disk');
	// The worker dies with its server connection, so its node reads stopped too.
	await expect(topology).toContainText('process stopped');
	// Every workflow control is gated off while the server is down.
	await expect(page.getByRole('button', { name: 'Place order' }).first()).toBeDisabled();

	// The embedded Temporal UI is replaced by an explicit down state.
	await page
		.getByRole('tablist', { name: 'Workbench view' })
		.getByRole('tab', { name: 'Temporal UI' })
		.click();
	await expect(page.getByText('Temporal Server is stopped')).toBeVisible();

	await topology.getByRole('button', { name: 'Start', exact: true }).click();
	await expect(topology).toContainText('state persisted');
	await expect(topology).not.toContainText('stopped · state persisted to disk');
	await expect(page.getByRole('button', { name: 'Place order' }).first()).toBeEnabled();
});
