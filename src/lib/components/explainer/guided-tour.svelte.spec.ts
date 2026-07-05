/**
 * guided-tour.svelte.spec.ts — browser tests for the guided journey rail.
 * Runs in the "client" vitest project (headless Chromium).
 *
 * These tests verify:
 * - Component renders the first step (concept, title, instruction, watch line).
 * - The active step is announced via a live region.
 * - The CTA appears only when enabled and dispatches the step's control.
 * - The full step list is always visible with the active step marked.
 * - The completed-tour state renders when all steps are done.
 */

import { describe, expect, it, vi } from 'vitest';
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
		await expect.element(page.getByRole('heading', { name: TOUR[0].title })).toBeInTheDocument();
	});

	it('renders the first tour step concept, instruction, and watch line', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		await expect.element(page.getByText(TOUR[0].concept)).toBeInTheDocument();
		await expect.element(page.getByText(TOUR[0].instruction, { exact: false })).toBeInTheDocument();
		await expect.element(page.getByText(TOUR[0].watch, { exact: false })).toBeInTheDocument();
	});

	it('has a live region so step changes are announced to screen readers', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		const status = page.getByRole('status');
		await expect.element(status).toBeInTheDocument();
	});

	it('renders a progress indicator showing step count', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });
		await expect.element(page.getByRole('heading', { name: 'Guided journey' })).toBeInTheDocument();
		await expect.element(page.getByText('Step 1 of 10')).toBeInTheDocument();
	});

	it('always shows the full step list with the active step marked', async () => {
		render(GuidedTour, { props: { progress: initialProgress } });

		const nav = page.getByRole('navigation', { name: 'Tour progress' });
		const items = nav.getByRole('listitem');
		const allItems = await items.all();
		expect(allItems.length).toBe(TOUR.length);
		await expect
			.element(nav.getByText(TOUR[0].title).element().closest('li'))
			.toHaveAttribute('aria-current', 'step');
	});

	it('marks a skipped step distinctly from a completed one', async () => {
		// The learner completed step 0, then skipped step 1 (its event could never
		// fire): index advanced to 2 but step 1 is NOT in completedStepIds. The
		// "All steps" list must not falsely show step 1 as done.
		const progress: TourProgress = { currentStepIndex: 2, completedStepIds: [TOUR[0].id] };
		render(GuidedTour, { props: { progress } });

		const nav = page.getByRole('navigation', { name: 'Tour progress' });
		const skippedItem = nav.getByText(TOUR[1].title).element().closest('li');
		expect(skippedItem?.className).toContain('journey__step--skipped');
		expect(skippedItem?.className).not.toContain('journey__step--done');

		// The completed step still reads as done.
		const doneItem = nav.getByText(TOUR[0].title).element().closest('li');
		expect(doneItem?.className).toContain('journey__step--done');
		await expect.element(nav.getByText('(skipped)', { exact: false })).toBeInTheDocument();
	});

	it('shows the CTA when enabled and dispatches the step control', async () => {
		const oncta = vi.fn();
		render(GuidedTour, { props: { progress: initialProgress, ctaEnabled: true, oncta } });

		const cta = page.getByRole('button', { name: 'Place order' });
		await expect.element(cta).toBeInTheDocument();
		await cta.click();
		expect(oncta).toHaveBeenCalledWith('start-order');
	});

	it('shows a disabled CTA with a reason when the control cannot run yet', async () => {
		const oncta = vi.fn();
		render(GuidedTour, {
			props: {
				progress: initialProgress,
				ctaEnabled: false,
				ctaBlockedReason: 'The worker is offline. Restart it from the topology strip.',
				oncta
			}
		});

		// The action is still shown so the tour is never a silent dead-end, but it
		// is disabled (so it can't dispatch) and the blocked reason is explained.
		const cta = page.getByRole('button', { name: 'Place order' });
		await expect.element(cta).toBeDisabled();
		await expect
			.element(page.getByText('The worker is offline', { exact: false }))
			.toBeInTheDocument();
		expect(oncta).not.toHaveBeenCalled();
	});

	it('offers skip and restart when the step can no longer complete', async () => {
		// Deviation: the learner cancelled the order at the signal-accept step, so
		// its completing event can never arrive. The card must offer a way out.
		const signalStepIndex = TOUR.findIndex((step) => step.id === 'signal-accept');
		const progress: TourProgress = {
			currentStepIndex: signalStepIndex,
			completedStepIds: TOUR.slice(0, signalStepIndex).map((step) => step.id)
		};
		const onskip = vi.fn();
		const onrestart = vi.fn();
		render(GuidedTour, {
			props: { progress, ctaEnabled: false, stepStuck: true, onskip, onrestart }
		});

		await expect
			.element(page.getByText("This step can't complete anymore", { exact: false }))
			.toBeInTheDocument();

		await page.getByRole('button', { name: 'Skip this step' }).click();
		expect(onskip).toHaveBeenCalledOnce();

		await page.getByRole('button', { name: 'Restart tour' }).click();
		expect(onrestart).toHaveBeenCalledOnce();
	});

	it('replaces the CTA with the stuck notice — no dead disabled button', async () => {
		const signalStepIndex = TOUR.findIndex((step) => step.id === 'signal-accept');
		const progress: TourProgress = {
			currentStepIndex: signalStepIndex,
			completedStepIds: TOUR.slice(0, signalStepIndex).map((step) => step.id)
		};
		render(GuidedTour, {
			props: {
				progress,
				ctaEnabled: false,
				ctaBlockedReason: 'This step unlocks as the workflow reaches the right point.',
				stepStuck: true
			}
		});

		// The step's own action (and its blocked reason) must not render: the
		// workflow is terminal, so "waiting" copy would be a lie.
		await expect
			.element(page.getByText("This step can't complete anymore", { exact: false }))
			.toBeInTheDocument();
		expect(
			page.getByRole('button', { name: 'Send restaurant-accepted signal' }).query()
		).toBeNull();
		expect(page.getByText('unlocks as the workflow', { exact: false }).query()).toBeNull();
	});

	it('does not show the stuck notice when the step can still complete', async () => {
		render(GuidedTour, { props: { progress: initialProgress, ctaEnabled: true } });
		await expect.element(page.getByRole('button', { name: 'Place order' })).toBeInTheDocument();
		expect(page.getByText("This step can't complete anymore", { exact: false }).query()).toBeNull();
	});

	it('shows a watching indicator on steps without a control', async () => {
		// Step 2 (activities-run) has no control — it completes from events alone.
		const progress: TourProgress = { currentStepIndex: 1, completedStepIds: [TOUR[0].id] };
		render(GuidedTour, { props: { progress, ctaEnabled: false } });
		await expect
			.element(page.getByText('Watching the system respond', { exact: false }))
			.toBeInTheDocument();
	});

	it('flips the kill-worker CTA label when the worker is offline', async () => {
		const killStepIndex = TOUR.findIndex((step) => step.control === 'kill-worker');
		const progress: TourProgress = {
			currentStepIndex: killStepIndex,
			completedStepIds: TOUR.slice(0, killStepIndex).map((step) => step.id)
		};
		render(GuidedTour, { props: { progress, ctaEnabled: true, workerOnline: false } });
		await expect
			.element(page.getByRole('button', { name: 'Restart the worker' }))
			.toBeInTheDocument();
	});

	it('offers a code experiment on steps that carry one', async () => {
		// The durable-timer step ships a "shrink the deadline" experiment.
		const timerStepIndex = TOUR.findIndex((step) => step.id === 'durable-timer');
		const step = TOUR[timerStepIndex];
		expect(step.experiment).toBeDefined();

		const onshowcode = vi.fn();
		const progress: TourProgress = {
			currentStepIndex: timerStepIndex,
			completedStepIds: TOUR.slice(0, timerStepIndex).map((s) => s.id)
		};
		render(GuidedTour, { props: { progress, onshowcode } });

		await expect.element(page.getByText('Try changing the code')).toBeInTheDocument();
		// The prompt renders as Markdown (inline code splits text nodes), so
		// assert on a plain-text fragment rather than the full string.
		await expect
			.element(page.getByText('Shrink the deadline', { exact: false }))
			.toBeInTheDocument();

		await page.getByRole('button', { name: 'Show me the code' }).click();
		expect(onshowcode).toHaveBeenCalledWith(step.experiment);
	});

	it('offers a "where to look" callout that navigates to a surface', async () => {
		// The durable-timer step points into the Temporal Web UI.
		const timerStepIndex = TOUR.findIndex((step) => step.id === 'durable-timer');
		const step = TOUR[timerStepIndex];
		expect(step.lookAt).toBeDefined();
		expect(step.lookAt!.surface).toBe('temporal-ui');

		const onlookat = vi.fn();
		const progress: TourProgress = {
			currentStepIndex: timerStepIndex,
			completedStepIds: TOUR.slice(0, timerStepIndex).map((s) => s.id)
		};
		render(GuidedTour, { props: { progress, onlookat } });

		await expect.element(page.getByText('Where to look')).toBeInTheDocument();
		await page.getByRole('button', { name: 'Open the Temporal UI' }).click();
		expect(onlookat).toHaveBeenCalledWith(step.lookAt);
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
		const heading = page.getByRole('heading', { name: TOUR[0].title });
		await expect.element(heading).toBeVisible();
	});
});
