<script lang="ts">
	/**
	 * order-timeline.svelte — maps `TimelineEntry[]` from the `getTimeline`
	 * query onto Cinder's `RunStepTimeline` step format.
	 */
	import RunStepTimeline from '@lostgradient/cinder/run-step-timeline';
	import type { RunStep, RunStepStatus } from '@lostgradient/cinder/run-step-timeline';
	import type { TimelineEntry, OrderStatus } from '$lib/contracts/workflow-api';

	let { entries }: { entries: TimelineEntry[] } = $props();

	/** Map domain order status onto the generic `RunStepStatus` values. */
	function toRunStepStatus(status: OrderStatus): RunStepStatus {
		switch (status) {
			case 'CREATED':
				return 'pending';
			case 'VALIDATING':
				return 'running';
			case 'AWAITING_RESTAURANT':
				return 'waiting_approval';
			case 'PREPARING':
				return 'running';
			case 'AWAITING_COURIER':
				return 'waiting_approval';
			case 'IN_DELIVERY':
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
		entries.map((entry) => ({
			id: String(entry.index),
			label: entry.description,
			status: toRunStepStatus(entry.status),
			startTime: entry.timestamp
		}))
	);
</script>

{#if steps.length > 0}
	<RunStepTimeline {steps} label="Order timeline" />
{/if}
