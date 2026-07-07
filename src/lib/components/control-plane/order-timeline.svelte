<script lang="ts">
	/**
	 * order-timeline.svelte — maps the `TimelineEntry[]` from the polled
	 * `getStatus` snapshot onto Cinder's `RunStepTimeline` step format.
	 */
	import RunStepTimeline from '@lostgradient/cinder/run-step-timeline';
	import type { RunStep, RunStepStatus } from '@lostgradient/cinder/run-step-timeline';
	import type { TimelineEntry, OrderStatus } from '$lib/contracts/workflow-api';

	let { entries }: { entries: TimelineEntry[] } = $props();

	/** Map domain order status onto the generic `RunStepStatus` values. */
	function toRunStepStatus(status: OrderStatus): RunStepStatus {
		switch (status) {
			case 'RECEIVED':
				return 'running';
			case 'WAITING_FOR_RESTAURANT':
				return 'waiting_approval';
			case 'PREPARING':
				return 'running';
			case 'DELIVERED':
				return 'succeeded';
			case 'CANCELLED':
				return 'cancelled';
			case 'REFUNDED':
				return 'cancelled';
			default:
				return 'pending';
		}
	}

	const steps = $derived<RunStep[]>(
		entries.map((entry, index) => ({
			id: String(index),
			label: entry.description,
			status: toRunStepStatus(entry.status),
			startTime: entry.timestamp
		}))
	);
</script>

{#if steps.length > 0}
	<RunStepTimeline {steps} label="Order timeline" />
{/if}
