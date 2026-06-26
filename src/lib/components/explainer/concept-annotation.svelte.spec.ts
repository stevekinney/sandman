/**
 * concept-annotation.svelte.spec.ts — browser tests for ConceptAnnotation.
 * Runs in the "client" vitest project (headless Chromium).
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ConceptAnnotation from './concept-annotation.svelte';
import { FEATURE_MAP, CONTROL_FEATURE } from '$lib/content/demo-script';

describe('ConceptAnnotation', () => {
	it('renders nothing when no controlId is provided (hidden by default)', async () => {
		render(ConceptAnnotation, { props: { controlId: undefined } });
		// Without a controlId there should be no callout visible
		const callout = page.getByRole('note');
		// It may not be present at all, or it may be hidden
		const elements = await callout.all();
		expect(elements.length).toBe(0);
	});

	it('renders the concept name as text for a given controlId', async () => {
		const controlId = 'start-order';
		const featureId = CONTROL_FEATURE[controlId];
		const entry = FEATURE_MAP[featureId];
		render(ConceptAnnotation, { props: { controlId } });
		await expect.element(page.getByText(entry.concept)).toBeInTheDocument();
	});

	it('renders the oneLiner for a given controlId', async () => {
		const controlId = 'accept-restaurant';
		const featureId = CONTROL_FEATURE[controlId];
		const entry = FEATURE_MAP[featureId];
		render(ConceptAnnotation, { props: { controlId } });
		await expect.element(page.getByText(entry.oneLiner, { exact: false })).toBeInTheDocument();
	});

	it('annotation is keyboard-reachable (region or note role)', async () => {
		const controlId = 'kill-worker';
		render(ConceptAnnotation, { props: { controlId } });
		// The annotation should be a note, region, or article that assistive tech can reach
		const note = page.getByRole('note');
		await expect.element(note).toBeInTheDocument();
	});

	it('concept is conveyed by text, not color alone', async () => {
		const controlId = 'update-address';
		const featureId = CONTROL_FEATURE[controlId];
		const entry = FEATURE_MAP[featureId];
		render(ConceptAnnotation, { props: { controlId } });
		// The concept name must appear as visible text
		await expect.element(page.getByText(entry.concept)).toBeVisible();
	});
});
