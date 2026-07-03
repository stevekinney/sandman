/**
 * temporal-ui-frame.svelte.spec.ts — browser component tests for TemporalUiFrame.
 *
 * Runs in the "client" vitest project (headless Chromium via Playwright).
 * Uses vitest-browser-svelte to mount the component into a real browser.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import TemporalUiFrame from './temporal-ui-frame.svelte';

const connectedProbe = () => vi.fn(async () => true);
const disconnectedProbe = () => vi.fn(async () => false);
const inertFrameSource = 'about:blank';

describe('TemporalUiFrame', () => {
	afterEach(() => vi.restoreAllMocks());

	it('renders an iframe with the proxied UI URL', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', probe: connectedProbe(), frameSource: inertFrameSource }
		});
		const iframe = page.getByTitle('Temporal Web UI');
		await expect.element(iframe).toBeInTheDocument();
		await expect.element(iframe).toHaveAttribute('data-proxied-src', '/sbx/sbx-test-123/ui/');
	});

	it('renders a live-region StatusDot for connection state', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', probe: connectedProbe(), frameSource: inertFrameSource }
		});
		// StatusDot with connectionState renders role="status" for live-region semantics.
		await expect.element(page.getByRole('status')).toBeInTheDocument();
	});

	it('shows "Temporal UI" label text', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', probe: connectedProbe(), frameSource: inertFrameSource }
		});
		await expect.element(page.getByText('Temporal UI')).toBeInTheDocument();
	});

	it('shows a Sandman startup state before the Temporal Web UI is reachable', async () => {
		render(TemporalUiFrame, {
			props: {
				sandboxId: 'sbx-test-123',
				sandboxStatus: 'bootstrapping',
				probe: disconnectedProbe()
			}
		});

		await expect.element(page.getByText('Starting Temporal services')).toBeInTheDocument();
		await expect
			.element(page.getByText('Temporal server, worker, and Web UI', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByTitle('Temporal Web UI')).not.toBeInTheDocument();
	});

	it('shows a connecting state when the sandbox is ready but the Web UI probe has not succeeded', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', sandboxStatus: 'ready', probe: disconnectedProbe() }
		});

		await expect.element(page.getByText('Connecting to Temporal UI')).toBeInTheDocument();
		await expect.element(page.getByTitle('Temporal Web UI')).not.toBeInTheDocument();
	});

	it('derives the proxied URL from the sandboxId prop', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-custom-id', probe: connectedProbe(), frameSource: inertFrameSource }
		});
		const iframe = page.getByTitle('Temporal Web UI');
		await expect.element(iframe).toHaveAttribute('data-proxied-src', '/sbx/sbx-custom-id/ui/');
	});

	it('accepts an optional class prop without error', async () => {
		render(TemporalUiFrame, {
			props: {
				sandboxId: 'sbx-test-123',
				class: 'custom-class',
				probe: connectedProbe(),
				frameSource: inertFrameSource
			}
		});
		// Component renders without throwing.
		await expect.element(page.getByTitle('Temporal Web UI')).toBeInTheDocument();
	});

	it('shows connected state when the probe returns 200', async () => {
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', probe: connectedProbe(), frameSource: inertFrameSource }
		});
		// Wait for the $effect probe to resolve and StatusDot to update.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'connected');
	});

	it('passes the proxied URL and abort signal to the reachability probe', async () => {
		const probe = connectedProbe();
		render(TemporalUiFrame, {
			props: { sandboxId: 'sbx-test-123', probe, frameSource: inertFrameSource }
		});

		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'connected');
		expect(probe).toHaveBeenCalledWith('/sbx/sbx-test-123/ui/', expect.any(AbortSignal));
	});

	it('shows disconnected state when the probe returns 502', async () => {
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123', probe: disconnectedProbe() } });
		// A 502 from our proxy route means the sandbox is unreachable.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'disconnected');
	});

	it('shows disconnected state when the probe throws a network error', async () => {
		const probe = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123', probe } });
		// Network-level failures (no connection) also show disconnected.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'disconnected');
	});
});
