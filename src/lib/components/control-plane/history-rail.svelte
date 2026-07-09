<script lang="ts">
	/**
	 * history-rail.svelte — the "Workflow history" rail.
	 *
	 * Two lenses over the same durable history: the raw live event stream
	 * (Cinder EventStreamViewer via event-rail) and the friendly step timeline
	 * (Cinder RunStepTimeline via order-timeline). Also links out to the full
	 * Temporal Web UI in the center view.
	 */
	import EmptyState from '@lostgradient/cinder/empty-state';
	import type { EventStreamState } from '@lostgradient/cinder/event-stream-viewer';
	import Segment from '@lostgradient/cinder/segment';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import EventRail from './event-rail.svelte';
	import OrderTimeline from './order-timeline.svelte';
	import type { SessionState } from './session-state.svelte.ts';

	let {
		session,
		lens = $bindable('events')
	}: {
		session: SessionState;
		/** Which lens is active — bindable so the tour can navigate it. */
		lens?: 'events' | 'steps';
	} = $props();

	const eventStreamState = $derived<EventStreamState>(
		!session.workerOnline ? 'disconnected' : session.workerRestarting ? 'connecting' : 'connected'
	);

	function historyTabId(nextLens: 'events' | 'steps'): string {
		return `history-lens-${nextLens}-tab`;
	}
</script>

<aside class="history" aria-label="Workflow history">
	<div class="history__header">
		<h2 class="history__title">Workflow history</h2>
		<div class="history__tabs">
			<SegmentedControl
				id="history-lens"
				label="History lens"
				size="sm"
				fullWidth
				variant="tablist"
				bind:value={lens}
			>
				<Segment
					value="events"
					id={historyTabId('events')}
					controls="history-lens-events-panel"
				>
					Events
				</Segment>
				<Segment
					value="steps"
					id={historyTabId('steps')}
					controls="history-lens-steps-panel"
				>
					Steps
				</Segment>
			</SegmentedControl>
		</div>
	</div>

	<div
		id="history-lens-events-panel"
		role="tabpanel"
		tabindex="0"
		aria-labelledby={historyTabId('events')}
		class="history__panel"
		hidden={lens !== 'events'}
	>
		<p class="history__hint">
			Everything the worker and workflow do as it happens — retries, signals, timers, recoveries.
		</p>
		<div class="history__stream">
			<EventRail events={session.workflowEvents} connectionState={eventStreamState} />
		</div>
	</div>

	<div
		id="history-lens-steps-panel"
		role="tabpanel"
		tabindex="0"
		aria-labelledby={historyTabId('steps')}
		class="history__panel history__steps"
		hidden={lens !== 'steps'}
	>
		<p class="history__hint history__hint--flush">
			A plain-language view of the run — the same durable history, as friendly steps.
		</p>
		{#if session.timelineEntries.length > 0}
			<OrderTimeline entries={session.timelineEntries} />
		{:else}
			<EmptyState
				title="No run yet"
				description="Place an order to watch its durable history here."
			/>
		{/if}
	</div>
</aside>

<style>
	.history {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}

	.history__header {
		flex: none;
		padding: 0.75rem 0.875rem 0.625rem;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.history__title {
		margin: 0 0 0.5rem;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.history__hint {
		flex: none;
		margin: 0;
		padding: 0.75rem 1rem;
		font-size: 0.6875rem;
		line-height: 1.4;
		color: var(--cinder-text-subtle);
	}

	.history__hint--flush {
		padding: 0 0 0.75rem;
	}

	.history__panel {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
	}

	.history__panel[hidden] {
		display: none;
	}

	.history__stream {
		flex: 1;
		min-height: 0;
		padding: 0.125rem 0.75rem 0.75rem;
		overflow: hidden;
	}

	.history__steps {
		overflow-y: auto;
		padding: 0.875rem;
	}

	@media (max-width: 68rem) {
		.history__stream {
			min-height: 20rem;
		}
	}
</style>
