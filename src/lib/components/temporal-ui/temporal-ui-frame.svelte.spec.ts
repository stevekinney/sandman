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

describe('TemporalUiFrame', () => {
	afterEach(() => vi.restoreAllMocks());

	it('renders an iframe with the proxied UI URL', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		const iframe = page.getByTitle('Temporal Web UI');
		await expect.element(iframe).toBeInTheDocument();
		await expect.element(iframe).toHaveAttribute('src', '/sbx/sbx-test-123/ui/');
	});

	it('renders a live-region StatusDot for connection state', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		// StatusDot with connectionState renders role="status" for live-region semantics.
		await expect.element(page.getByRole('status')).toBeInTheDocument();
	});

	it('shows "Temporal UI" label text', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		await expect.element(page.getByText('Temporal UI')).toBeInTheDocument();
	});

	it('derives the proxied URL from the sandboxId prop', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-custom-id' } });
		const iframe = page.getByTitle('Temporal Web UI');
		await expect.element(iframe).toHaveAttribute('src', '/sbx/sbx-custom-id/ui/');
	});

	it('accepts an optional class prop without error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123', class: 'custom-class' } });
		// Component renders without throwing.
		await expect.element(page.getByTitle('Temporal Web UI')).toBeInTheDocument();
	});

	it('shows connected state when the probe returns 200', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		// Wait for the $effect probe to resolve and StatusDot to update.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'connected');
	});

	it('shows disconnected state when the probe returns 502', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		// A 502 from our proxy route means the sandbox is unreachable.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'disconnected');
	});

	it('shows disconnected state when the probe throws a network error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		render(TemporalUiFrame, { props: { sandboxId: 'sbx-test-123' } });
		// Network-level failures (no connection) also show disconnected.
		await expect
			.element(page.getByRole('status'))
			.toHaveAttribute('data-cinder-state', 'disconnected');
	});
});
