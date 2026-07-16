import { expect, test } from '@playwright/test';

test('home page renders the hero heading and Sandman brand', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toHaveText(
		'A real Temporal server in your browser, in seconds.'
	);
	await expect(page.locator('h1')).toBeVisible();
	// The Sandman brand still surfaces in the footer tagline.
	await expect(page.getByText('Ephemeral Temporal sandboxes in the browser')).toBeVisible();
});

test('home page enables session provisioning after the user enters an email', async ({ page }) => {
	await page.goto('/');
	const newSessionButton = page.getByRole('button', { name: 'New Session' });
	await expect(newSessionButton).toBeVisible();
	await expect(newSessionButton).toBeDisabled();

	await page.getByLabel('Email').fill('sandman@example.com');
	await expect(newSessionButton).toBeEnabled();
});

test('home page mock history actions use app-owned inert markup', async ({ page }) => {
	await page.goto('/');

	const historyActions = page.locator('.sd-history__actions');
	await expect(
		historyActions.locator('.sd-history-action').filter({ hasText: 'Send signal' })
	).toHaveCount(1);
	await expect(
		historyActions.locator('.sd-history-action').filter({ hasText: 'Kill worker' })
	).toHaveCount(1);
	await expect(historyActions.getByRole('button')).toHaveCount(0);
});

test('home page carries complete HTML and OpenGraph metadata', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle('Sandman — Ephemeral Temporal sandboxes in the browser');
	await expect(page.locator('meta[name="description"]')).toHaveAttribute(
		'content',
		/resume exactly where it left off/
	);
	await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0b0f17');
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);

	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /^Sandman — /);
	await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /.+/);
	await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'Sandman');
	await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website');
	await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /^http/);
	await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
	await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
	await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', /.+/);
	await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
		'content',
		'summary_large_image'
	);
	await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', /.+/);

	// The social-card image must actually resolve.
	const ogImageUrl = await page.locator('meta[property="og:image"]').getAttribute('content');
	expect(ogImageUrl).toMatch(/^http.*\/og-image\.png$/);
	const imageResponse = await page.request.get(ogImageUrl!);
	expect(imageResponse.status()).toBe(200);
	expect(imageResponse.headers()['content-type']).toContain('image/png');
});
