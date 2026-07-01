<script lang="ts">
	/**
	 * control-toolbar.svelte — the one-click Temporal control strip.
	 *
	 * Order-lifecycle signals on the left, read/mutate interactions in the
	 * middle, cancel on its own, and the Code / Temporal UI view switch on the
	 * right. Every button maps 1:1 to a `ControlId` and is gated by
	 * `session.canDo`; the control recommended by the guided tour gets a glow.
	 */
	import Button from '@lostgradient/cinder/button';
	import ButtonGroup from '@lostgradient/cinder/button-group';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import Segment from '@lostgradient/cinder/segment';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/button-group/styles';
	import '@lostgradient/cinder/segmented-control/styles';
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
</script>

<div class="toolbar">
	<ButtonGroup label="Order lifecycle">
		{#each lifecycleControls as { control, label } (control)}
			<Button
				variant={control === 'start-order' ? 'primary' : 'secondary'}
				size="sm"
				{label}
				disabled={!session.canDo(control)}
				loading={session.pendingControl === control}
				class={buttonClass(control)}
				onclick={() => void session.dispatch(control)}
			/>
		{/each}
	</ButtonGroup>

	<ButtonGroup label="Workflow interactions">
		{#each interactionControls as { control, label } (control)}
			<Button
				variant="secondary"
				size="sm"
				{label}
				disabled={!session.canDo(control)}
				loading={session.pendingControl === control}
				class={buttonClass(control)}
				onclick={() => void session.dispatch(control)}
			/>
		{/each}
	</ButtonGroup>

	<Button
		variant="soft-danger"
		size="sm"
		label="Cancel & refund"
		disabled={!session.canDo('cancel-order')}
		loading={session.pendingControl === 'cancel-order'}
		onclick={() => void session.cancelOrder()}
	/>

	<div class="toolbar__view">
		<SegmentedControl
			id="center-view"
			label="Workbench view"
			hideLabel
			density="toolbar"
			variant="tablist"
			value={view}
			onchange={(next) => (view = next as CenterView)}
		>
			<Segment value="code" controls="center-panel-code">Code</Segment>
			<Segment value="temporal" controls="center-panel-temporal">Temporal UI</Segment>
		</SegmentedControl>
	</div>
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-wrap: wrap;
		padding: 0.5rem 1rem;
		background: var(--cinder-surface);
		border-bottom: 1px solid var(--cinder-border);
	}

	.toolbar :global(.toolbar-button--recommended) {
		box-shadow:
			0 0 0 2px var(--cinder-accent),
			0 0 15px -3px var(--cinder-accent);
	}

	.toolbar__view {
		margin-left: auto;
	}
</style>
