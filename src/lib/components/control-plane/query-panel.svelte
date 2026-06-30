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
	import type { QueryName } from '$lib/contracts/workflow-api';

	let {
		controller,
		workflowId,
		onqueried
	}: {
		controller: TemporalController;
		workflowId: string;
		onqueried?: (name: QueryName) => void;
	} = $props();

	let loading = $state(false);
	let queryResult = $state<{ name: QueryName; value: unknown } | null>(null);
	let error = $state<string | null>(null);

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
</script>

<section aria-label="Query controls">
	<div class="query-buttons">
		<Button
			label="Get Status"
			variant="secondary"
			{loading}
			onclick={() => runQuery('getStatus')}
		/>
		<Button
			label="Get Timeline"
			variant="secondary"
			{loading}
			onclick={() => runQuery('getTimeline')}
		/>
	</div>

	{#if error}
		<p role="alert" class="error">{error}</p>
	{/if}

	{#if queryResult !== null}
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
