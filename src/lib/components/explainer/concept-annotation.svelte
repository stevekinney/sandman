<script lang="ts">
	/**
	 * concept-annotation.svelte — what-just-happened / why-it-matters callout
	 * shown when a control is activated in the Sandman demo.
	 *
	 * Props:
	 *   controlId — the ControlId that was triggered (undefined hides the callout).
	 */
	import Callout from '@lostgradient/cinder/callout';
	import type { ControlId } from '$lib/contracts/workflow-api';
	import { FEATURE_MAP, CONTROL_FEATURE } from '$lib/content/demo-script';

	type Props = {
		/** The control that was just triggered; undefined = nothing to show. */
		controlId: ControlId | undefined;
	};

	let { controlId }: Props = $props();

	const entry = $derived(
		controlId !== undefined ? FEATURE_MAP[CONTROL_FEATURE[controlId]] : undefined
	);
</script>

{#if entry !== undefined}
	<!--
		Wrap in a div with role="note" so assistive tech identifies this as a note.
		Callout's root is <aside> which strips the role prop, so we add the wrapper.
	-->
	<div role="note" aria-label="Temporal concept: {entry.concept}" class="concept-annotation">
		<Callout variant="info" title={entry.concept}>
			<p class="concept-annotation__one-liner">{entry.oneLiner}</p>
			<p class="concept-annotation__mechanic">{entry.mechanic}</p>
		</Callout>
	</div>
{/if}

<style>
	.concept-annotation {
		margin-block: 0.75rem;
	}

	.concept-annotation__one-liner {
		font-style: italic;
		margin-block-end: 0.25rem;
	}

	.concept-annotation__mechanic {
		font-size: 0.875rem;
		line-height: 1.5;
	}
</style>
