import { expect, test } from '@playwright/test';

test('home page renders the Sandman heading', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toHaveText('Sandman');
	await expect(page.locator('h1')).toBeVisible();
});

test('home page uses the Cinder button for session provisioning', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'New Session' })).toHaveClass(/cinder-button/);
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
