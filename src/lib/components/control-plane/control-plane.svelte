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
	 * The order timeline (`OrderTimeline` → Cinder `RunStepTimeline`) is rendered
	 * directly. Its live data (`timelineEntries`) is supplied by the parent, which
	 * owns the `getTimeline` poll — keeping this component's own controller-query
	 * surface limited to explicit user actions. The parent learns the active run
	 * via the `onstarted` callback so it can scope its poll to the workflow ID.
	 */
	import type { TemporalController, WorkflowRun } from './types.ts';
	import type { WorkflowEvent } from '$lib/contracts/events';
	import type { TimelineEntry } from '$lib/contracts/workflow-api';
	import StartOrderForm from './start-order-form.svelte';
	import SignalControls from './signal-controls.svelte';
	import QueryPanel from './query-panel.svelte';
	import UpdateControls from './update-controls.svelte';
	import EventRail from './event-rail.svelte';
	import ChaosControls from './chaos-controls.svelte';
	import OrderTimeline from './order-timeline.svelte';

	let {
		controller,
		events = [],
		timelineEntries = [],
		onstarted
	}: {
		controller: TemporalController;
		/**
		 * Live workflow event stream, provided by the parent (e.g. via SSE or
		 * periodic polling). `EventRail` handles sorting and deduplication internally.
		 */
		events?: WorkflowEvent[];
		/**
		 * Live `getTimeline` snapshot, provided by the parent. Rendered as a
		 * Cinder `RunStepTimeline`. Defaults to empty (timeline hidden) so tests
		 * and pre-start states render nothing.
		 */
		timelineEntries?: TimelineEntry[];
		/** Called once when a workflow run starts, so the parent can scope its poll. */
		onstarted?: (run: WorkflowRun) => void;
	} = $props();

	let workflowRun = $state<WorkflowRun | null>(null);

	function handleStarted(run: WorkflowRun): void {
		workflowRun = run;
		onstarted?.(run);
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

		<OrderTimeline entries={timelineEntries} />
	{/if}
</div>
