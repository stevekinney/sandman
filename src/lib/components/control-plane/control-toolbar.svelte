<script lang="ts">
	/**
	 * control-toolbar.svelte — the one-click Temporal control strip.
	 *
	 * Order-lifecycle signals on the left, read/mutate interactions in the
	 * middle, cancel on its own — all in a Cinder `Toolbar` that draws the
	 * separators between groups, is a single roving-tabindex tab stop, and wraps
	 * responsively. The Code / Temporal UI switch sits to the right as its own
	 * tablist (kept outside the toolbar so its arrow-key selection isn't
	 * swallowed by the toolbar's roving navigation). Every button maps 1:1 to a
	 * `ControlId` and is gated by `session.canDo`; the control recommended by
	 * the guided tour gets a glow.
	 */
	import Button from '@lostgradient/cinder/button';
	import Toolbar from '@lostgradient/cinder/toolbar';
	import { Tabs } from '@lostgradient/cinder/tabs';
	import type { ControlId } from '$lib/contracts/workflow-api';
	import type { SessionState } from './session-state.svelte.ts';
	import type { CenterView } from './session-actions.ts';

	let {
		session,
		view = $bindable('code')
	}: {
		session: SessionState;
		view?: CenterView;
	} = $props();

	type ToolbarControl = { control: ControlId; label: string };

	const lifecycleControls: ToolbarControl[] = [
		{ control: 'start-order', label: 'Place order' },
		{ control: 'accept-restaurant', label: 'Restaurant accepted' },
		{ control: 'food-ready', label: 'Food ready' },
		{ control: 'complete-delivery', label: 'Complete delivery' }
	];

	const interactionControls: ToolbarControl[] = [
		{ control: 'update-address', label: 'Update address' },
		{ control: 'query-status', label: 'Get status' },
		{ control: 'list-visibility', label: 'List visibility' },
		{ control: 'add-tip', label: 'Add tip' }
	];

	function buttonClass(control: ControlId): string {
		return session.recommendedControl === control ? 'toolbar-button--recommended' : '';
	}

	/**
	 * Why a control is disabled right now, for the button's tooltip — so a greyed
	 * button explains itself instead of leaving the user guessing. Returns
	 * undefined when the control is usable.
	 */
	function controlTitle(control: ControlId): string | undefined {
		if (session.canDo(control)) return undefined;
		if (session.pendingControl !== null || session.serverPending !== null) {
			return 'Another action is in progress…';
		}
		// `sandboxUsable` is false both while provisioning and once the sandbox is
		// unusable (expired/error), so keep this phrasing accurate for both.
		if (!session.sandboxUsable) return 'The sandbox is not ready.';
		if (!session.serverOnline) return 'Start the Temporal server (topology strip) to use this.';
		if (!session.workerOnline) return 'Restart the worker (topology strip) to use this.';
		return 'Not available at this point in the order yet.';
	}
</script>

<div class="toolbar-shell">
	<Toolbar aria-label="Order controls">
		<Toolbar.Group role="group" aria-label="Order lifecycle">
			{#each lifecycleControls as { control, label } (control)}
				<Button
					variant={control === 'start-order' ? 'primary' : 'secondary'}
					size="sm"
					{label}
					disabled={!session.canDo(control)}
					title={controlTitle(control)}
					loading={session.pendingControl === control}
					class={buttonClass(control)}
					onclick={() => void session.dispatch(control)}
				/>
			{/each}
		</Toolbar.Group>

		<Toolbar.Group role="group" aria-label="Workflow interactions">
			{#each interactionControls as { control, label } (control)}
				<Button
					variant="secondary"
					size="sm"
					{label}
					disabled={!session.canDo(control)}
					title={controlTitle(control)}
					loading={session.pendingControl === control}
					class={buttonClass(control)}
					onclick={() => void session.dispatch(control)}
				/>
			{/each}
		</Toolbar.Group>

		<Toolbar.Group role="group" aria-label="Destructive actions">
			<Button
				variant="soft-danger"
				size="sm"
				label="Cancel & refund"
				disabled={!session.canDo('cancel-order')}
				title={controlTitle('cancel-order')}
				loading={session.pendingControl === 'cancel-order'}
				class={buttonClass('cancel-order')}
				onclick={() => void session.cancelOrder()}
			/>
		</Toolbar.Group>
	</Toolbar>

	<div class="toolbar-shell__view">
		<Tabs bind:value={view} class="toolbar-shell__tabs">
			<Tabs.List label="Workbench view">
				<Tabs.Trigger value="code">Code</Tabs.Trigger>
				<Tabs.Trigger value="temporal">Temporal UI</Tabs.Trigger>
			</Tabs.List>
		</Tabs>
	</div>
</div>

<style>
	.toolbar-shell {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.5rem 1rem;
		background: var(--cinder-surface);
		border-bottom: 1px solid var(--cinder-border);
	}

	/* Take the row and push the view switch to the far edge. The Toolbar only
	   wraps at its own 30rem container breakpoint, which leaves intermediate
	   widths overflowing — allow its groups to wrap so buttons never collide.
	   Workaround for stevekinney/cinder#613. */
	.toolbar-shell :global(.cinder-toolbar) {
		flex: 1 1 100%;
		flex-wrap: wrap;
		min-width: 0;
		row-gap: 0.5rem;
	}

	.toolbar-shell__view {
		flex: 0 0 11rem;
		inline-size: 11rem;
		margin-inline-start: auto;
	}

	.toolbar-shell__view :global(.toolbar-shell__tabs),
	.toolbar-shell__view :global(.cinder-tab-list) {
		inline-size: 100%;
	}

	.toolbar-shell :global(.toolbar-button--recommended) {
		box-shadow:
			0 0 0 2px var(--cinder-accent),
			0 0 15px -3px var(--cinder-accent);
	}
</style>
