<script lang="ts">
	/**
	 * feature-legend.svelte — renders one row per Temporal feature.
	 * Data-driven from FEATURE_MAP; TypeScript anti-drift ensures the table
	 * stays in sync with the contract's FeatureId union.
	 */
	import Badge from '@lostgradient/cinder/badge';
	import { FEATURE_MAP } from '$lib/content/demo-script';

	const entries = Object.values(FEATURE_MAP);
</script>

<section aria-label="Temporal feature legend" class="feature-legend">
	<h2 class="feature-legend__heading">Feature Legend</h2>
	<p class="feature-legend__intro">
		Every Temporal primitive demonstrated by the Sandman food-ordering workflow.
	</p>
	<table class="feature-legend__table">
		<thead>
			<tr>
				<th scope="col">Feature</th>
				<th scope="col">Concept</th>
				<th scope="col">How it is demonstrated</th>
				<th scope="col">Control</th>
			</tr>
		</thead>
		<tbody>
			{#each entries as entry (entry.id)}
				<tr>
					<td class="feature-legend__id">
						<code>{entry.id}</code>
					</td>
					<td class="feature-legend__concept">
						<strong>{entry.concept}</strong>
					</td>
					<td class="feature-legend__mechanic">{entry.mechanic}</td>
					<td class="feature-legend__control">
						{#if entry.control}
							<Badge>{entry.control}</Badge>
						{:else}
							<span class="feature-legend__no-control" aria-label="no direct control">—</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>

<style>
	.feature-legend {
		width: 100%;
	}

	.feature-legend__heading {
		font-size: 1.125rem;
		font-weight: 600;
		margin-block-end: 0.5rem;
	}

	.feature-legend__intro {
		font-size: 0.875rem;
		color: var(--color-text-secondary, #6b7280);
		margin-block-end: 1rem;
	}

	.feature-legend__table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.feature-legend__table th {
		text-align: start;
		padding: 0.5rem 0.75rem;
		border-bottom: 2px solid var(--color-border, #e5e7eb);
		font-weight: 600;
	}

	.feature-legend__table td {
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		vertical-align: top;
	}

	.feature-legend__id code {
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.feature-legend__mechanic {
		max-width: 32rem;
		line-height: 1.5;
	}

	.feature-legend__no-control {
		color: var(--color-text-muted, #9ca3af);
	}
</style>
