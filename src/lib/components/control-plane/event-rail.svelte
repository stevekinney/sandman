<script lang="ts">
	/**
	 * event-rail.svelte — wraps Cinder's `EventStreamViewer` with sorting and
	 * deduplication so the rail is correct even when events arrive out of order
	 * or are replayed with duplicate sequence numbers.
	 *
	 * Sequence-gap detection stays OFF: this feed is sparse by design (only
	 * annotated timeline entries are surfaced, and synthetic control-plane
	 * events use a high sequence range), so gaps carry no meaning here.
	 */
	import EventStreamViewer from '@lostgradient/cinder/event-stream-viewer';
	import type { StreamEvent } from '@lostgradient/cinder';
	import type { WorkflowEvent } from '$lib/contracts/events';
	import type { EventStreamState } from '@lostgradient/cinder';

	let {
		events = [],
		connectionState
	}: {
		events?: WorkflowEvent[];
		connectionState?: EventStreamState;
	} = $props();

	/** Replace raw workflow ids with the actor a learner can reason about. */
	function sourceLabel(workflowId: string | undefined): string {
		if (workflowId === undefined) return 'control plane';
		if (workflowId.startsWith('delivery-')) return 'delivery child';
		return 'order';
	}

	/** Compact local wall-clock label; the full ISO stamp stays on <time datetime>. */
	function timeLabel(iso: string): string {
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime())
			? iso
			: parsed.toLocaleTimeString('en-US', { hour12: false });
	}

	/**
	 * Sort by sequence number then deduplicate: two events with the same
	 * sequence are identical (Temporal guarantees sequence uniqueness within
	 * a single run), so keep only the first occurrence.
	 */
	const streamEvents = $derived(
		[...events]
			.sort((a, b) => a.sequence - b.sequence)
			.filter(
				(event, index, sorted) => index === 0 || sorted[index - 1].sequence !== event.sequence
			)
			.map(
				(event): StreamEvent => ({
					id: String(event.sequence),
					sequence: event.sequence,
					datetime: event.timestamp,
					timestamp: timeLabel(event.timestamp),
					summary: event.type,
					source: sourceLabel(event.workflowId),
					details: event.payload ?? undefined
				})
			)
	);
</script>

<EventStreamViewer
	events={streamEvents}
	{connectionState}
	label="Workflow event stream"
	detectSequenceGaps={false}
	followLatest={true}
/>
