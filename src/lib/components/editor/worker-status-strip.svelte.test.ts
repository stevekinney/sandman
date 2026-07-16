/**
 * worker-status-strip.svelte.test.ts — browser component tests for WorkerStatusStrip.
 * Runs in the "client" vitest project (headless Chromium via Playwright).
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import WorkerStatusStrip from './worker-status-strip.svelte';

describe('WorkerStatusStrip', () => {
	it('renders nothing when workerStatus is null', async () => {
		const { container } = render(WorkerStatusStrip, { workerStatus: null });
		expect(container.querySelector('[data-phase]')).toBeNull();
	});

	it('shows restarting state with correct label', async () => {
		render(WorkerStatusStrip, { workerStatus: { ok: false, phase: 'restarting' } });
		// Use exact:true to match the Badge text ("Restarting"), not the StatusDot label ("Worker restarting")
		await expect.element(page.getByText('Restarting', { exact: true })).toBeInTheDocument();
	});

	it('shows ready state with correct label', async () => {
		render(WorkerStatusStrip, { workerStatus: { ok: true, phase: 'ready' } });
		await expect.element(page.getByText('Ready', { exact: true })).toBeInTheDocument();
	});

	it('shows compile-error state with correct label', async () => {
		render(WorkerStatusStrip, {
			workerStatus: { ok: false, phase: 'compile-error', stderr: '' }
		});
		await expect.element(page.getByText('Compile Error', { exact: true })).toBeInTheDocument();
	});

	it('surfaces captured stderr in the compile-error state', async () => {
		const stderr = 'TS2345: Argument of type string is not assignable to number';
		render(WorkerStatusStrip, {
			workerStatus: { ok: false, phase: 'compile-error', stderr }
		});
		await expect.element(page.getByText(stderr)).toBeInTheDocument();
	});

	it('does NOT render stderr block when stderr is empty in compile-error', async () => {
		const { container } = render(WorkerStatusStrip, {
			workerStatus: { ok: false, phase: 'compile-error', stderr: '' }
		});
		// No semantic preformatted error output should be rendered for empty stderr.
		expect(container.querySelector('pre')).toBeNull();
	});
});
