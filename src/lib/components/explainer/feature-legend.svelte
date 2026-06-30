<script lang="ts">
	/**
	 * feature-legend.svelte — renders one row per Temporal feature.
	 * Data-driven from FEATURE_MAP; TypeScript anti-drift ensures the table
	 * stays in sync with the contract's FeatureId union.
	 */
	import Badge from '@lostgradient/cinder/badge';
	import Table from '@lostgradient/cinder/table';
	import { FEATURE_MAP } from '$lib/content/demo-script';
	import '@lostgradient/cinder/table/styles';

	const entries = Object.values(FEATURE_MAP);
</script>

<section aria-label="Temporal feature legend" class="feature-legend">
	<h2 class="feature-legend__heading">Feature Legend</h2>
	<p class="feature-legend__intro">
		Every Temporal primitive demonstrated by the Sandman food-ordering workflow.
	</p>
	<div class="feature-legend__table-scroll">
		<Table class="feature-legend__table" density="condensed">
			<Table.Header>
				<Table.Row>
					<Table.HeaderCell>Feature</Table.HeaderCell>
					<Table.HeaderCell>Concept</Table.HeaderCell>
					<Table.HeaderCell>How it is demonstrated</Table.HeaderCell>
					<Table.HeaderCell>Control</Table.HeaderCell>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each entries as entry (entry.id)}
					<Table.Row>
						<Table.Cell as="th" class="feature-legend__id">
							<code>{entry.id}</code>
						</Table.Cell>
						<Table.Cell class="feature-legend__concept">
							<strong>{entry.concept}</strong>
						</Table.Cell>
						<Table.Cell class="feature-legend__mechanic">{entry.mechanic}</Table.Cell>
						<Table.Cell class="feature-legend__control">
							{#if entry.control}
								<Badge>{entry.control}</Badge>
							{:else}
								<span class="feature-legend__no-control" aria-label="no direct control">—</span>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table>
	</div>
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

	.feature-legend__table-scroll {
		width: 100%;
		overflow-x: auto;
	}

	.feature-legend :global(.feature-legend__table) {
		min-width: 44rem;
	}

	.feature-legend :global(.feature-legend__id code) {
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.feature-legend :global(.feature-legend__mechanic) {
		max-width: 32rem;
		line-height: 1.5;
	}

	.feature-legend__no-control {
		color: var(--color-text-muted, #9ca3af);
	}
</style>
