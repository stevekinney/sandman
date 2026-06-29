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
