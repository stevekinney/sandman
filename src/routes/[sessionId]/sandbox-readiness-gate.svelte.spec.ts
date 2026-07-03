import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SandboxReadinessGate from './sandbox-readiness-gate.svelte';

describe('SandboxReadinessGate', () => {
	it('shows progress while the sandbox is provisioning', async () => {
		render(SandboxReadinessGate, {
			props: { status: 'provisioning', errorMessage: null, inviteRequired: false }
		});

		await expect.element(page.getByRole('status')).toBeInTheDocument();
		await expect.element(page.getByText('Starting sandbox')).toBeInTheDocument();
		await expect.element(page.getByText('Step 1 of 3')).toBeInTheDocument();
		await expect.element(page.getByRole('progressbar')).toHaveAttribute('value', '34');
		await expect.element(page.getByText('Provision sandbox')).toBeInTheDocument();
	});

	it('shows the bootstrapping step while Temporal services start', async () => {
		render(SandboxReadinessGate, {
			props: { status: 'bootstrapping', errorMessage: null, inviteRequired: false }
		});

		await expect.element(page.getByText('Step 2 of 3')).toBeInTheDocument();
		await expect.element(page.getByRole('progressbar')).toHaveAttribute('value', '67');
		await expect.element(page.getByText('Start Temporal services')).toBeInTheDocument();
	});

	it('shows the unavailable alert and recovery action for invite-gated sandboxes', async () => {
		render(SandboxReadinessGate, {
			props: { status: 'authentication-required', errorMessage: null, inviteRequired: true }
		});

		await expect.element(page.getByRole('alert')).toBeInTheDocument();
		await expect.element(page.getByText('This sandbox link needs a session')).toBeInTheDocument();
		await expect
			.element(page.getByRole('link', { name: 'Enter invite code' }))
			.toHaveAttribute('href', '/');
	});

	it('renders nothing once the sandbox is ready', () => {
		const { container } = render(SandboxReadinessGate, {
			props: { status: 'ready', errorMessage: null, inviteRequired: false }
		});

		expect(container.textContent?.trim()).toBe('');
	});
});
