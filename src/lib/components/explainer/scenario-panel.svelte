<script lang="ts">
	/**
	 * scenario-panel.svelte — plain-English description of the current workflow stage.
	 * Derives display copy from SCENARIO_COPY based on the current OrderStatus.
	 *
	 * Props:
	 *   status — the current OrderStatus returned by a getStatus query.
	 */
	import Badge from '@lostgradient/cinder/badge';
	import type { OrderStatus } from '$lib/contracts/workflow-api';
	import { SCENARIO_COPY } from '$lib/content/demo-script';

	type Props = {
		/** Current order lifecycle status from the getStatus query. */
		status: OrderStatus;
	};

	let { status }: Props = $props();

	const copy = $derived(SCENARIO_COPY[status]);
</script>

<section aria-label="Current scenario" class="scenario-panel">
	<header class="scenario-panel__header">
		<span class="scenario-panel__label">Current Stage</span>
		<Badge variant="neutral">{status}</Badge>
	</header>
	<p class="scenario-panel__copy">{copy}</p>
</section>

<style>
	.scenario-panel {
		padding: 1rem;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 0.5rem;
		background: var(--color-surface-subtle, #f9fafb);
	}

	.scenario-panel__header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-block-end: 0.75rem;
	}

	.scenario-panel__label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary, #6b7280);
	}

	.scenario-panel__copy {
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--color-text-primary, #111827);
		margin: 0;
	}
</style>
