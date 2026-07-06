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
	import '@lostgradient/cinder/empty-state/styles';
	import '@lostgradient/cinder/segmented-control/styles';
	import type { EventStreamState } from '@lostgradient/cinder/event-stream-viewer';
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

	function setLens(nextLens: 'events' | 'steps'): void {
		lens = nextLens;
	}

	function focusLens(nextLens: 'events' | 'steps'): void {
		document.querySelector<HTMLButtonElement>(`[data-history-lens="${nextLens}"]`)?.focus();
	}

	function handleLensKeydown(event: KeyboardEvent): void {
		const nextLens =
			event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'End'
				? 'steps'
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home'
					? 'events'
					: null;

		if (nextLens === null) return;
		event.preventDefault();
		setLens(nextLens);
		requestAnimationFrame(() => focusLens(nextLens));
	}
</script>

<aside class="history" aria-label="Workflow history">
	<div class="history__header">
		<h2 class="history__title">Workflow history</h2>
		<div
			id="history-lens"
			class="cinder-segmented-control"
			role="radiogroup"
			aria-label="History lens"
			data-cinder-size="sm"
			data-cinder-full-width=""
		>
			<button
				type="button"
				class="cinder-segmented-control-option"
				role="radio"
				aria-checked={lens === 'events'}
				tabindex={lens === 'events' ? 0 : -1}
				data-history-lens="events"
				data-cinder-selected={lens === 'events' ? '' : undefined}
				onclick={() => setLens('events')}
				onkeydown={handleLensKeydown}
			>
				Events
			</button>
			<button
				type="button"
				class="cinder-segmented-control-option"
				role="radio"
				aria-checked={lens === 'steps'}
				tabindex={lens === 'steps' ? 0 : -1}
				data-history-lens="steps"
				data-cinder-selected={lens === 'steps' ? '' : undefined}
				onclick={() => setLens('steps')}
				onkeydown={handleLensKeydown}
			>
				Steps
			</button>
		</div>
	</div>

	{#if lens === 'events'}
		<p class="history__hint">
			Everything the worker and workflow do as it happens — retries, signals, timers, recoveries.
		</p>
		<div class="history__stream">
			<EventRail events={session.workflowEvents} connectionState={eventStreamState} />
		</div>
	{:else}
		<div class="history__steps">
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
	{/if}
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

	.history__stream {
		flex: 1;
		min-height: 0;
		padding: 0.125rem 0.75rem 0.75rem;
		overflow: hidden;
	}

	.history__steps {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.875rem;
	}

	@media (max-width: 68rem) {
		.history__stream {
			min-height: 20rem;
		}
	}
</style>
