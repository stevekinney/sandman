<script lang="ts">
	/**
	 * event-rail.svelte — wraps Cinder's `EventStreamViewer` with sorting and
	 * deduplication so the rail is correct even when events arrive out of order
	 * or are replayed with duplicate sequence numbers.
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
					summary: event.type,
					source: event.workflowId,
					details: event.payload ?? undefined
				})
			)
	);
</script>

<EventStreamViewer
	events={streamEvents}
	{connectionState}
	label="Workflow event stream"
	detectSequenceGaps={true}
	followLatest={true}
/>
