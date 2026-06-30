<script lang="ts">
	/**
	 * command-inspector.svelte — teaching view for UI actions mapped to Temporal.
	 *
	 * Shows the latest action as a short explanation, then keeps the full command
	 * log available for learners who want to inspect payloads and results.
	 */
	import PayloadInspector from '@lostgradient/cinder/payload-inspector';
	import type { CommandLogEntry } from './types.ts';
	import type { WorkflowEvent } from '$lib/contracts/events';

	let {
		entries = [],
		latestEvent
	}: {
		entries?: CommandLogEntry[];
		latestEvent?: WorkflowEvent;
	} = $props();

	const latestEntry = $derived(entries.at(-1));
	const latestEventExplanation = $derived(
		latestEvent === undefined
			? 'No Temporal history event has been observed yet.'
			: explainEvent(latestEvent)
	);
	const latestCommandExplanation = $derived(
		latestEntry === undefined ? undefined : explainCommand(latestEntry)
	);

	function explainCommand(entry: CommandLogEntry): string {
		if (entry.primitive === 'visibility') {
			return 'Temporal Visibility reads indexed Search Attributes across workflow executions. Unlike a workflow query, it does not need a specific running workflow handler.';
		}
		if (entry.primitive === 'query') {
			return 'A workflow query reads state from one execution without adding a history event or advancing workflow code.';
		}
		if (entry.primitive === 'update') {
			return 'A workflow update validates synchronously and then records accepted mutation work in workflow history.';
		}
		if (entry.primitive === 'signal') {
			return 'A signal appends an external event to workflow history so the workflow can react when it next runs.';
		}
		if (entry.primitive === 'worker') {
			return 'Worker commands affect only the polling process. The workflow state remains in the Temporal server.';
		}
		return 'Starting a workflow creates a durable execution with its own event history.';
	}

	function explainEvent(event: WorkflowEvent): string {
		if (event.type.startsWith('ActivityTask')) {
			return 'Temporal recorded activity work in history. On replay, the workflow receives the recorded activity result instead of doing the side effect again.';
		}
		if (event.type.startsWith('Timer')) {
			return 'Temporal stored a durable timer in the server. The timer can fire even if the worker process is stopped.';
		}
		if (event.type.startsWith('WorkflowExecutionSignaled')) {
			return 'An external signal was appended to workflow history, letting the workflow resume from condition().';
		}
		if (event.type.startsWith('WorkflowExecutionUpdate')) {
			return 'A workflow update went through the synchronous update path, including validator behavior before mutation.';
		}
		if (event.type.startsWith('ChildWorkflow') || event.type.startsWith('StartChildWorkflow')) {
			return 'The parent workflow created a child workflow, which is independently visible in Temporal Web.';
		}
		if (event.type === 'WorkerRestarted') {
			return 'The worker came back. Temporal will replay history so workflow code reconstructs the same durable state.';
		}
		if (event.type === 'WorkflowExecutionCompleted') {
			return 'The workflow reached a terminal completed state and Temporal recorded the result in history.';
		}
		if (event.type === 'WorkflowExecutionContinuedAsNew') {
			return 'The workflow compacted history by starting a fresh run with carried-forward state.';
		}
		return 'A Temporal history event was observed and fed into the guided tour.';
	}

	function formatTime(timestamp: string): string {
		return new Intl.DateTimeFormat('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(timestamp));
	}
</script>

<section class="command-inspector" aria-label="Command and event inspector">
	<header class="command-inspector__header">
		<div>
			<p class="command-inspector__eyebrow">What just happened?</p>
			<h2>Command and history inspector</h2>
		</div>
		<span>{entries.length} command{entries.length === 1 ? '' : 's'}</span>
	</header>

	<div class="command-inspector__latest">
		{#if latestEntry === undefined}
			<p>Start an order to see the UI action, API route, Temporal command, payload, and result.</p>
		{:else}
			<p class="command-inspector__label">
				<span>{latestEntry.status}</span>
				{latestEntry.label}
			</p>
			<dl>
				<div>
					<dt>API route</dt>
					<dd>{latestEntry.apiRoute}</dd>
				</div>
				<div>
					<dt>Temporal command</dt>
					<dd><code>{latestEntry.temporalCommand}</code></dd>
				</div>
			</dl>
			{#if latestCommandExplanation}
				<p>{latestCommandExplanation}</p>
			{/if}
		{/if}
	</div>

	<div class="command-inspector__event">
		<p class="command-inspector__eyebrow">Latest history signal</p>
		<p>{latestEventExplanation}</p>
		{#if latestEvent !== undefined}
			<p class="command-inspector__event-type">
				{latestEvent.type}
				<span>{formatTime(latestEvent.timestamp)}</span>
			</p>
		{/if}
	</div>

	{#if entries.length > 0}
		<details class="command-inspector__details">
			<summary>Inspect command log</summary>
			<PayloadInspector value={entries} label="Command log" activeView="raw" />
		</details>
	{/if}
</section>

<style>
	.command-inspector {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 1rem;
		border-bottom: 1px solid #1f2937;
		background: #08111f;
		color: #e2e8f0;
	}

	.command-inspector__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.command-inspector__header h2 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.25;
	}

	.command-inspector__header > span,
	.command-inspector__eyebrow,
	.command-inspector__event-type span {
		color: #94a3b8;
		font-size: 0.75rem;
	}

	.command-inspector__eyebrow {
		margin: 0 0 0.25rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.command-inspector__latest,
	.command-inspector__event {
		padding: 0.875rem;
		border: 1px solid #334155;
		border-radius: 0.5rem;
		background: #0f172a;
	}

	.command-inspector__latest p,
	.command-inspector__event p {
		margin: 0;
		line-height: 1.5;
	}

	.command-inspector__label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 700;
	}

	.command-inspector__label span {
		padding: 0.125rem 0.4rem;
		border-radius: 999px;
		background: #1e293b;
		color: #bfdbfe;
		font-size: 0.7rem;
		text-transform: uppercase;
	}

	.command-inspector dl {
		display: grid;
		gap: 0.5rem;
		margin: 0.75rem 0 0;
	}

	.command-inspector dt {
		margin: 0 0 0.125rem;
		color: #94a3b8;
		font-size: 0.75rem;
	}

	.command-inspector dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.command-inspector code {
		color: #bae6fd;
		font-size: 0.78rem;
	}

	.command-inspector__event-type {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.625rem;
		color: #bfdbfe;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.78rem;
	}

	.command-inspector__details {
		border: 1px solid #334155;
		border-radius: 0.5rem;
		background: #0f172a;
	}

	.command-inspector__details summary {
		cursor: pointer;
		padding: 0.75rem 0.875rem;
		color: #e2e8f0;
		font-weight: 700;
	}

	.command-inspector__details :global(.cinder-payload-inspector) {
		border-top: 1px solid #334155;
	}
</style>
