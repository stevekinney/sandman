/**
 * sandbox-ui.e2e.ts — end-to-end Playwright tests for the session UI shell.
 *
 * Tests:
 *  - Navigating to /{sessionId} renders the three-panel layout.
 *  - The Temporal Web UI iframe is present with the correct proxied src path.
 *  - The editor panel is present.
 *  - The control plane panel is present.
 *
 * These tests do NOT require a live E2B sandbox — they verify structure only.
 * The iframe will contain the proxy's 502 error page when no sandbox is
 * registered, which is the expected state during CI without E2B credentials.
 */

import { expect, test } from '@playwright/test';

const TEST_SESSION_ID = 'e2e-test-session-iframe';

test('session page renders the Sandman heading', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('h1')).toHaveText('Sandman');
});

test('session page shows the sandbox ID in the header', async ({ page }) => {
	await page.goto(`/${TEST_SESSION_ID}`);
	await expect(page.locator('.session-id')).toContainText(TEST_SESSION_ID);
});

test('TemporalUiFrame renders an iframe whose src is the proxied path', async ({ page }) => {
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
