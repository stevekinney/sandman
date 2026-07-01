<script lang="ts">
	/**
	 * query-panel.svelte — query trigger buttons that render their result
	 * via Cinder's `PayloadInspector`.
	 *
	 * Queries: getStatus, getTimeline.
	 */
	import Button from '@lostgradient/cinder/button';
	import PayloadInspector from '@lostgradient/cinder/payload-inspector';
	import type { TemporalController } from './types.ts';
	import type { ControlId, QueryName } from '$lib/contracts/workflow-api';

	let {
		controller,
		workflowId,
		recommendedControl,
		onqueried
	}: {
		controller: TemporalController;
		workflowId: string;
		recommendedControl?: ControlId;
		onqueried?: (name: QueryName) => void;
	} = $props();

	let loading = $state(false);
	let queryResult = $state<{ name: QueryName; value: unknown } | null>(null);
	let error = $state<string | null>(null);

	type StatusSummary = {
		status: string;
		orderStatus: string | null;
		customerTier: string | null;
		restaurantId: string | null;
	};

	async function runQuery(name: QueryName): Promise<void> {
		loading = true;
		error = null;
		queryResult = null;
		try {
			const value = await controller.query(workflowId, name);
			queryResult = { name, value };
			onqueried?.(name);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function getStatusSummary(value: unknown): StatusSummary | null {
		if (!isRecord(value)) return null;
		const status = readString(value.status);
		if (status === null) return null;
		const businessSnapshot = isRecord(value.businessSnapshot) ? value.businessSnapshot : {};
		return {
			status,
			orderStatus: readString(businessSnapshot.OrderStatus),
			customerTier: readString(businessSnapshot.CustomerTier),
			restaurantId: readString(businessSnapshot.RestaurantId)
		};
	}

	function readString(value: unknown): string | null {
		return typeof value === 'string' && value.length > 0 ? value : null;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}

	function shouldShow(name: QueryName): boolean {
		if (recommendedControl === undefined) return true;
		return (
			(recommendedControl === 'query-status' && name === 'getStatus') ||
			(recommendedControl === 'query-timeline' && name === 'getTimeline')
		);
	}
</script>

<section aria-label="Query controls">
	<div class="query-buttons">
		{#if shouldShow('getStatus')}
			<Button
				label="Get Status"
				variant={recommendedControl === 'query-status' ? 'primary' : 'secondary'}
				{loading}
				onclick={() => runQuery('getStatus')}
			/>
		{/if}
		{#if shouldShow('getTimeline')}
			<Button
				label="Get Timeline"
				variant={recommendedControl === 'query-timeline' ? 'primary' : 'secondary'}
				{loading}
				onclick={() => runQuery('getTimeline')}
			/>
		{/if}
	</div>

	{#if error}
		<p role="alert" class="error">{error}</p>
	{/if}

	{#if queryResult !== null}
		{#if queryResult.name === 'getStatus'}
			{@const statusSummary = getStatusSummary(queryResult.value)}
			{#if statusSummary !== null}
				<section class="query-summary" aria-label="Current workflow snapshot">
					<p class="query-summary__eyebrow">Current workflow snapshot</p>
					<p class="query-summary__lead">
						The workflow is currently <strong>{statusSummary.status}</strong>. This query read state
						without advancing the order.
					</p>
					<dl class="query-summary__facts">
						{#if statusSummary.orderStatus !== null}
							<div>
								<dt>OrderStatus</dt>
								<dd>{statusSummary.orderStatus}</dd>
							</div>
						{/if}
						{#if statusSummary.customerTier !== null}
							<div>
								<dt>CustomerTier</dt>
								<dd>{statusSummary.customerTier}</dd>
							</div>
						{/if}
						{#if statusSummary.restaurantId !== null}
							<div>
								<dt>RestaurantId</dt>
								<dd>{statusSummary.restaurantId}</dd>
							</div>
						{/if}
					</dl>
				</section>
			{/if}
		{/if}
		<!--
			activeView="raw" ensures the JSON text is always in the DOM so tests
			(and screen-reader users) can read the value without having to switch
			tabs. The Raw tab renders a plain <pre><code> block with highlight=false,
			which means the value is accessible as literal text.
		-->
		<PayloadInspector
			value={queryResult.value}
			label="Query result: {queryResult.name}"
			activeView="raw"
		/>
	{/if}
</section>

<style>
	.query-summary {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.75rem;
		padding: 0.875rem;
		border: 1px solid var(--cinder-border, #334155);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--cinder-surface, #0f172a), #38bdf8 8%);
	}

	.query-summary__eyebrow,
	.query-summary__lead,
	.query-summary__facts {
		margin: 0;
	}

	.query-summary__eyebrow {
		font-size: 0.75rem;
		font-weight: 800;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.query-summary__lead {
		line-height: 1.5;
		color: var(--cinder-text, #e2e8f0);
	}

	.query-summary__facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.5rem;
	}

	.query-summary__facts div {
		min-width: 0;
		padding: 0.5rem;
		border: 1px solid var(--cinder-border-muted, #1f2937);
		border-radius: 0.375rem;
	}

	.query-summary__facts dt {
		font-size: 0.72rem;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.query-summary__facts dd {
		margin: 0.15rem 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 700;
		color: var(--cinder-text, #e2e8f0);
	}
</style>
