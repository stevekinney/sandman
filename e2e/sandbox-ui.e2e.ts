/**
 * sandbox-ui.e2e.ts — end-to-end Playwright tests for the session UI shell.
 *
 * Tests:
 *  - Navigating to /{sessionId} renders the three-panel layout.
 *  - The Temporal Web UI iframe is present with the correct proxied src path.
 *  - The editor panel is present.
 *  - The control plane panel is present.
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
	await expect(page.locator('.session-id')).toContainText(TEST_SESSION_ID);
});

test('TemporalUiFrame renders an iframe whose src is the proxied path', async ({ page }) => {
	await mockReadySandbox(page);
	await page.goto(`/${TEST_SESSION_ID}`);

	// The iframe must be present in the DOM with the correct same-origin proxy src.
	const iframe = page.locator('iframe[title="Temporal Web UI"]');
	await expect(iframe).toBeVisible();

	const src = await iframe.getAttribute('src');
	expect(src).toBe(`/sbx/${TEST_SESSION_ID}/ui/`);
});

test('editor panel is rendered and labelled', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('[aria-label="Code editor"]')).toBeVisible();
});

test('editor file navigation uses Cinder tabs', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('.cinder-tabs')).toBeVisible();
	await expect(page.getByRole('tablist', { name: 'Editor files' })).toHaveClass(/cinder-tab-list/);
	await expect(page.getByRole('tab', { name: 'workflows.ts' })).toHaveClass(/cinder-tab/);
});

test('control plane panel is rendered and labelled', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('[aria-label="Control plane and guided tour"]')).toBeVisible();
});
