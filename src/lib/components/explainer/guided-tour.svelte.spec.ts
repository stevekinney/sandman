/**
 * guided-tour.svelte.spec.ts — browser tests for GuidedTour.
 * Runs in the "client" vitest project (headless Chromium).
 *
 * These tests verify:
 * - Component renders the first step initially.
 * - The active step is announced via a live region.
 * - Progress can be reset.
 * - Concept is conveyed by text, not color alone.
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import GuidedTour from './guided-tour.svelte';
import { TOUR } from '$lib/content/demo-script';
import type { TourProgress } from '$lib/content/tour-engine';

/** A memory-only progress prop for the component (bypasses localStorage). */
const initialProgress: TourProgress = { currentStepIndex: 0, completedStepIds: [] };

describe('GuidedTour', () => {
	it('renders the first tour step title in the detail heading', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		// The active step title is rendered as an h3 inside the detail region.
		await expect.element(page.getByRole('heading', { name: TOUR[0].title })).toBeInTheDocument();
	});

	it('renders the first tour step instruction', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		await expect.element(page.getByText(TOUR[0].instruction, { exact: false })).toBeInTheDocument();
	});

	it('has a live region so step changes are announced to screen readers', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		// The detail area has role="status" which is a live region.
		const status = page.getByRole('status');
		await expect.element(status).toBeInTheDocument();
	});

	it('renders a progress indicator showing step count', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		// Count text is in a <span> inside the header
		await expect.element(page.getByRole('heading', { name: 'Guided Tour' })).toBeInTheDocument();
		await expect.element(page.getByText('Step 1 of 10')).toBeInTheDocument();
	});

	it('keeps the full tour map available behind a disclosure', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });

		await page.getByText('Tour map').click();
		const nav = page.getByRole('navigation', { name: 'Tour progress' });
		const items = nav.getByRole('listitem');
		const allItems = await items.all();
		expect(allItems.length).toBe(TOUR.length);
	});

	it('displays a reset button', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		const resetBtn = page.getByRole('button', { name: /reset/i });
		await expect.element(resetBtn).toBeInTheDocument();
	});

	it('shows a completed-tour state when all steps are done', async () => {
		const completeProgress: TourProgress = {
			currentStepIndex: TOUR.length,
			completedStepIds: TOUR.map((s) => s.id)
		};
		render(GuidedTour, { props: { progress: completeProgress } });
		await expect.element(page.getByText('Tour complete', { exact: false })).toBeInTheDocument();
	});

	it('concept is conveyed by text, not color alone', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		// The step detail heading must be visible as text (not color-only encoding)
		const heading = page.getByRole('heading', { name: TOUR[0].title });
		await expect.element(heading).toBeVisible();
	});
});
