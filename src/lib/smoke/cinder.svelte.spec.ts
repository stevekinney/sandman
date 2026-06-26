/**
 * cinder.svelte.spec.ts — browser smoke test verifying a real Cinder component renders.
 * Runs in the "client" vitest project (headless Chromium via Playwright).
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import CinderBadgeSmoke from './cinder-badge-smoke.svelte';

describe('Cinder Badge (smoke)', () => {
	it('renders a badge with text content into the DOM', async () => {
		render(CinderBadgeSmoke);
		await expect.element(page.getByText('sandman')).toBeInTheDocument();
	});
});
