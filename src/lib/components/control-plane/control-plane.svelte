<script lang="ts">
	/**
	 * control-plane.svelte — root composition component for the Sandman demo.
	 *
	 * Renders a start-order form before any workflow is running, then switches
	 * to the full control panel (signals, queries, updates, event rail, chaos)
	 * once a workflow run is active.
	 *
	 * `controller` is the seam: production callers pass a `FetchController`;
	 * tests inject `MockTemporalController`.
	 *
	 * The order timeline (`RunStepTimeline`) is intentionally not statically
	 * imported here — it is a separate `OrderTimeline` component that callers
	 * can compose alongside `ControlPlane` when they need it. This avoids a
	 * Vite/Rolldown optimization crash caused by `@lostgradient/cinder`'s
	 * `RunStepTimeline` → `Collapsible` → `use-reduced-motion.svelte.ts` chain
	 * producing a TypeScript `export type` that Rolldown's JS parser cannot handle.
	 * See: https://github.com/lostgradient/cinder (issue filed separately).
	 */
	import type { Snippet } from 'svelte';
	import type { TemporalController, WorkflowRun } from './types.ts';
	import type { WorkflowEvent } from '$lib/contracts/events';
	import StartOrderForm from './start-order-form.svelte';
	import SignalControls from './signal-controls.svelte';
	import QueryPanel from './query-panel.svelte';
	import UpdateControls from './update-controls.svelte';
	import EventRail from './event-rail.svelte';
	import ChaosControls from './chaos-controls.svelte';

	let {
		controller,
		events = [],
		timeline
	}: {
		controller: TemporalController;
		/**
		 * Live workflow event stream, provided by the parent (e.g. via SSE or
		 * periodic polling). `EventRail` handles sorting and deduplication internally.
		 */
		events?: WorkflowEvent[];
		/**
		 * Optional snippet rendered below the event rail for the order timeline.
		 * Pass `{#snippet timeline(run)}<OrderTimeline ... />{/snippet}` from the
		 * parent to display `RunStepTimeline` without creating a static import that
		 * triggers the Vite optimizer failure described above.
		 */
		timeline?: Snippet<[WorkflowRun]>;
	} = $props();

	let workflowRun = $state<WorkflowRun | null>(null);

	function handleStarted(run: WorkflowRun): void {
		workflowRun = run;
	}
</script>

<div class="control-plane">
	{#if workflowRun === null}
		<StartOrderForm {controller} onstarted={handleStarted} />
	{:else}
		<header class="run-header">
			<dl class="run-meta">
				<div>
					<dt>Workflow ID</dt>
					<dd>{workflowRun.workflowId}</dd>
				</div>
				<div>
					<dt>Run ID</dt>
					<dd>{workflowRun.runId}</dd>
				</div>
			</dl>
		</header>

		<SignalControls {controller} workflowId={workflowRun.workflowId} />

		<QueryPanel {controller} workflowId={workflowRun.workflowId} />

		<UpdateControls {controller} workflowId={workflowRun.workflowId} />

		<ChaosControls {controller} />

		<EventRail {events} />

		{#if timeline}
			{@render timeline(workflowRun)}
		{/if}
	{/if}
</div>
