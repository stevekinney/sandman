<script lang="ts">
	/**
	 * +page.svelte — two-column Sandman session layout.
	 *
	 * Renders the demo as a tabbed workbench:
	 *  - Code Editor: code edit → hot-restart worker
	 *  - Workflow State: guided tour, controls, command history, and timeline
	 *  - Temporal UI: full-size proxied Temporal Web UI
	 *
	 * The sandboxId from the URL param drives all three surfaces.
	 * Components degrade gracefully when no live sandbox is provisioned
	 * (editor saves fail with 503, Temporal UI shows startup/error states,
	 * API calls show errors).
	 */
	import type { PageData } from './$types';
	import type { CommandLogEntry, WorkflowRun } from '$lib/components/control-plane/types';
	import type { TimelineEntry } from '$lib/contracts/workflow-api';
	import type { WorkflowEvent } from '$lib/contracts/events';
	import Editor from '$lib/components/editor/editor.svelte';
	import TemporalUiFrame from '$lib/components/temporal-ui/temporal-ui-frame.svelte';
	import ControlPlane from '$lib/components/control-plane/control-plane.svelte';
	import CommandInspector from '$lib/components/control-plane/command-inspector.svelte';
	import { FetchController } from '$lib/components/control-plane/fetch-controller';
	import { GuidedTour, TourState } from '$lib/components/explainer';
	import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
	import { tick } from 'svelte';
	import Button from '@lostgradient/cinder/button';
	import '@lostgradient/cinder/button/styles';
	import {
		getSandboxStatusDisplayLabel,
		getSandboxStatusFailureMessage,
		getSandboxStatusResponseFailureMessage,
		isSandboxUnusable
	} from './session-status';

	let { data }: { data: PageData } = $props();

	const controller = $derived(new FetchController(data.sandboxId));
	const tourState = new TourState(createVolatileTourStorage());

	// Live order timeline: poll `getTimeline` while a run is active and feed the
	// result to the control plane's `RunStepTimeline`. The control plane emits the
	// run via `onstarted` since it owns the start-order form.
	let run = $state<WorkflowRun | null>(null);
	let timelineEntries = $state<TimelineEntry[]>([]);
	let workflowEvents = $state<WorkflowEvent[]>([]);
	let commandLogEntries = $state<CommandLogEntry[]>([]);
	let sandboxStatus = $state<string>('provisioning');
	let sandboxStatusError = $state<string | null>(null);
	let workerOnline = $state(true);
	let lastFedTimelineWorkflowId: string | null = null;
	let lastFedTimelineEntryIndex = -1;
	const sandboxFailureMessage = $derived(
		getSandboxStatusFailureMessage(sandboxStatus, sandboxStatusError)
	);
	const sandboxUnusable = $derived(isSandboxUnusable(sandboxStatus));
	const inviteRequired = $derived(sandboxStatus === 'authentication-required');
	const latestWorkflowEvent = $derived(workflowEvents.at(-1));
	const recommendedControl = $derived(tourState.currentStep?.control);
	type SessionView = 'code' | 'workflow' | 'temporal';
	let activeSessionView = $state<SessionView>('workflow');

	$effect(() => {
		const sandboxId = data.sandboxId;
		let cancelled = false;

		async function pollStatus(): Promise<void> {
			try {
				const response = await fetch(`/api/sandbox/${sandboxId}/status`);
				if (!response.ok) {
					const responseBody = await response.text();
					if (!cancelled) {
						if (response.status === 401) sandboxStatus = 'authentication-required';
						sandboxStatusError = getSandboxStatusResponseFailureMessage(
							response.status,
							responseBody
						);
					}
					return;
				}
				const payload = (await response.json()) as {
					status: string;
					errorMessage: string | null;
				};
				if (!cancelled) {
					sandboxStatus = payload.status;
					sandboxStatusError = payload.errorMessage;
				}
			} catch (err) {
				if (!cancelled) sandboxStatusError = err instanceof Error ? err.message : String(err);
			}
		}

		void pollStatus();
		const handle = setInterval(() => void pollStatus(), 2000);
		return () => {
			cancelled = true;
			clearInterval(handle);
		};
	});

	$effect(() => {
		// Read `controller` synchronously so the effect is tracked against it and
		// re-subscribes if the sandbox (and thus the controller) identity changes.
		const activeController = controller;
		if (run === null || !workerOnline) return;
		const activeRun = run;
		const workflowId = activeRun.workflowId;
		let cancelled = false;

		async function poll(): Promise<void> {
			try {
				const entries = await activeController.query(workflowId, 'getTimeline');
				if (!cancelled && Array.isArray(entries)) {
					timelineEntries = entries;
					feedTimelineEvents(activeRun, entries);
				}
			} catch {
				// No live sandbox / worker yet — keep the last known entries.
			}
		}

		void poll();
		const handle = setInterval(() => void poll(), 2000);
		return () => {
			cancelled = true;
			clearInterval(handle);
		};
	});

	function feedTimelineEvents(activeRun: WorkflowRun, entries: TimelineEntry[]): void {
		if (lastFedTimelineWorkflowId !== activeRun.workflowId) {
			lastFedTimelineWorkflowId = activeRun.workflowId;
			lastFedTimelineEntryIndex = -1;
		}

		for (const entry of entries) {
			if (entry.index <= lastFedTimelineEntryIndex || entry.eventType === undefined) continue;
			handleWorkflowEvent({
				sequence: entry.index,
				type: entry.eventType,
				timestamp: entry.timestamp,
				workflowId: activeRun.workflowId,
				payload: {
					description: entry.description,
					status: entry.status,
					featureId: entry.featureId
				}
			});
			lastFedTimelineEntryIndex = entry.index;
		}
	}

	function handleRunStarted(nextRun: WorkflowRun): void {
		run = nextRun;
		timelineEntries = [];
		workflowEvents = [];
		commandLogEntries = [];
		workerOnline = true;
		lastFedTimelineWorkflowId = nextRun.workflowId;
		lastFedTimelineEntryIndex = -1;
	}

	function handleWorkflowEvent(event: WorkflowEvent): void {
		if (event.type === 'WorkerKilled') workerOnline = false;
		if (event.type === 'WorkerRestarted') workerOnline = true;
		tourState.feed(event);
		workflowEvents = [...workflowEvents, event];
	}

	function handleCommandEntry(entry: CommandLogEntry): void {
		const existingIndex = commandLogEntries.findIndex((candidate) => candidate.id === entry.id);
		if (existingIndex === -1) {
			commandLogEntries = [...commandLogEntries, entry];
			return;
		}
		commandLogEntries = commandLogEntries.map((candidate, index) =>
			index === existingIndex ? entry : candidate
		);
	}

	function createVolatileTourStorage(): StorageAdapter {
		let progress: TourProgress | null = null;
		return {
			load: () => progress,
			save: (nextProgress) => {
				progress = {
					currentStepIndex: nextProgress.currentStepIndex,
					completedStepIds: [...nextProgress.completedStepIds]
				};
			},
			clear: () => {
				progress = null;
			}
		};
	}

	async function focusGuidedDemo(event: MouseEvent): Promise<void> {
		event.preventDefault();
		activeSessionView = 'workflow';
		await tick();
		const target = document.getElementById('guided-demo');
		if (target === null) return;

		target.focus();
		target.scrollIntoView({ block: 'start' });
		history.replaceState(null, '', '#guided-demo');
	}

	async function focusSessionTab(view: SessionView): Promise<void> {
		await tick();
		document.getElementById(`session-tab-${view}`)?.focus();
	}

	function handleSessionTabKeydown(event: KeyboardEvent): void {
		const views: SessionView[] = ['code', 'workflow', 'temporal'];
		const currentIndex = views.indexOf(activeSessionView);
		if (currentIndex === -1) return;

		let nextIndex: number | null = null;
		if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % views.length;
		if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + views.length) % views.length;
		if (event.key === 'Home') nextIndex = 0;
		if (event.key === 'End') nextIndex = views.length - 1;
		if (nextIndex === null) return;

		event.preventDefault();
		activeSessionView = views[nextIndex] ?? activeSessionView;
		void focusSessionTab(activeSessionView);
	}
</script>

<div class="sandman-session">
	<a class="skip-demo-link" href="#guided-demo" onclick={focusGuidedDemo}>Skip to guided demo</a>

	<header class="session-header">
		<h1 class="session-title">Sandman</h1>
		<span class="session-id" title="Sandbox ID">{data.sandboxId}</span>
		<span class="session-status" data-status={sandboxStatus}>
			{getSandboxStatusDisplayLabel(sandboxStatus)}
		</span>
	</header>

	{#if sandboxFailureMessage}
		<div class="session-error" role="alert">
			<div class="session-error__copy">
				<strong>{inviteRequired ? 'Invite session required' : 'Sandbox unavailable'}</strong>
				<span>{sandboxFailureMessage}</span>
			</div>
			{#if inviteRequired}
				<Button href="/" label="Enter invite code" variant="secondary" size="sm" />
			{/if}
		</div>
	{/if}

	<main class="session-workbench" data-unusable={sandboxUnusable}>
		<div class="session-view-tabs" role="tablist" aria-label="Session views">
			<button
				id="session-tab-code"
				type="button"
				role="tab"
				class="session-view-tab"
				aria-selected={activeSessionView === 'code'}
				aria-controls="session-panel-code"
				tabindex={activeSessionView === 'code' ? 0 : -1}
				onclick={() => (activeSessionView = 'code')}
				onkeydown={handleSessionTabKeydown}
			>
				Code Editor
			</button>
			<button
				id="session-tab-workflow"
				type="button"
				role="tab"
				class="session-view-tab"
				aria-selected={activeSessionView === 'workflow'}
				aria-controls="session-panel-workflow"
				tabindex={activeSessionView === 'workflow' ? 0 : -1}
				onclick={() => (activeSessionView = 'workflow')}
				onkeydown={handleSessionTabKeydown}
			>
				Workflow State
			</button>
			<button
				id="session-tab-temporal"
				type="button"
				role="tab"
				class="session-view-tab"
				aria-selected={activeSessionView === 'temporal'}
				aria-controls="session-panel-temporal"
				tabindex={activeSessionView === 'temporal' ? 0 : -1}
				onclick={() => (activeSessionView = 'temporal')}
				onkeydown={handleSessionTabKeydown}
			>
				Temporal UI
			</button>
		</div>

		{#if activeSessionView === 'code'}
			<div
				id="session-panel-code"
				role="tabpanel"
				aria-labelledby="session-tab-code"
				class="session-view session-view--code"
			>
				<section class="panel panel--editor" aria-label="Code editor">
					<Editor sandboxId={data.sandboxId} />
				</section>
			</div>
		{:else if activeSessionView === 'workflow'}
			<div
				id="session-panel-workflow"
				role="tabpanel"
				aria-labelledby="session-tab-workflow"
				class="session-view session-view--workflow"
			>
				<div class="workflow-state-grid">
					<section class="panel panel--inspector" aria-label="Command and history inspector">
						<CommandInspector entries={commandLogEntries} latestEvent={latestWorkflowEvent} />
					</section>

					<aside
						id="guided-demo"
						tabindex="-1"
						class="panel panel--control"
						aria-label="Control plane and guided tour"
					>
						<div class="guided-tour-panel">
							<GuidedTour
								progress={{
									currentStepIndex: tourState.currentStepIndex,
									completedStepIds: [...tourState.completedStepIds]
								}}
								onreset={() => tourState.reset()}
							/>
						</div>
						<ControlPlane
							{controller}
							{timelineEntries}
							{recommendedControl}
							events={workflowEvents}
							onstarted={handleRunStarted}
							onworkflowevent={handleWorkflowEvent}
							oncommand={handleCommandEntry}
						/>
					</aside>
				</div>
			</div>
		{:else}
			<div
				id="session-panel-temporal"
				role="tabpanel"
				aria-labelledby="session-tab-temporal"
				class="session-view session-view--temporal"
			>
				<section class="panel panel--temporal-ui" aria-label="Temporal Web UI">
					<TemporalUiFrame sandboxId={data.sandboxId} {sandboxStatus} />
				</section>
			</div>
		{/if}
	</main>
</div>

<style>
	.sandman-session {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		background: #020617;
		color: var(--cinder-text, #e5e7eb);
	}

	.session-header {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.625rem 0.875rem;
		background: #111827;
		color: var(--cinder-text-subtle, #cbd5e1);
		border-bottom: 1px solid #334155;
		flex-shrink: 0;
	}

	.skip-demo-link {
		position: fixed;
		top: 0.75rem;
		left: 0.75rem;
		z-index: 1000;
		transform: translateY(-150%);
		border: 1px solid #38bdf8;
		border-radius: 0.375rem;
		background: #082f49;
		color: #e0f2fe;
		padding: 0.55rem 0.75rem;
		font-size: 0.875rem;
		font-weight: 700;
		text-decoration: none;
	}

	.skip-demo-link:focus {
		transform: translateY(0);
		outline: 2px solid #bae6fd;
		outline-offset: 2px;
	}

	.session-title {
		font-size: 1.125rem;
		font-weight: 700;
		margin: 0;
		color: #fff;
	}

	.session-id {
		font-family: monospace;
		font-size: 0.75rem;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.session-status {
		margin-left: auto;
		border: 1px solid #475569;
		border-radius: 999px;
		padding: 0.25rem 0.65rem;
		font-size: 0.75rem;
		text-transform: capitalize;
		font-weight: 600;
		color: var(--cinder-text, #e2e8f0);
	}

	.session-status[data-status='ready'] {
		border-color: #16a34a;
		color: #86efac;
	}

	.session-status[data-status='error'],
	.session-status[data-status='expired'],
	.session-status[data-status='terminated'] {
		border-color: #dc2626;
		color: #fca5a5;
	}

	.session-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		background: #2a1113;
		border-bottom: 1px solid #7f1d1d;
		color: #fecaca;
		padding: 0.6rem 1rem;
		font-size: 0.875rem;
	}

	.session-error__copy {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.75rem;
		align-items: baseline;
		min-width: 0;
	}

	.session-error__copy strong {
		color: #fee2e2;
	}

	.session-workbench {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #020617;
	}

	.session-view-tabs {
		display: flex;
		align-items: flex-end;
		gap: 0.25rem;
		padding: 0.55rem 0.75rem 0;
		border-bottom: 1px solid #1f2937;
		background: #08111f;
		flex-shrink: 0;
		overflow-x: auto;
	}

	.session-view-tab {
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 0.375rem 0.375rem 0 0;
		background: transparent;
		color: #94a3b8;
		cursor: pointer;
		font: inherit;
		font-size: 0.875rem;
		font-weight: 700;
		padding: 0.62rem 0.85rem;
		white-space: nowrap;
	}

	.session-view-tab:hover {
		background: #111827;
		color: #e2e8f0;
	}

	.session-view-tab[aria-selected='true'] {
		background: #0f172a;
		border-color: #334155;
		color: #f8fafc;
	}

	.session-view-tab:focus-visible {
		outline: 2px solid #60a5fa;
		outline-offset: -2px;
	}

	.session-view {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #020617;
	}

	.panel {
		min-height: 0;
		overflow: auto;
	}

	.panel--editor {
		height: 100%;
		overflow: hidden;
	}

	.workflow-state-grid {
		display: grid;
		grid-template-columns: minmax(22rem, 0.9fr) minmax(28rem, 1.1fr);
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.panel--inspector {
		min-width: 0;
		border-right: 1px solid #1f2937;
		background: #08111f;
	}

	.panel--temporal-ui {
		height: 100%;
		min-width: 0;
		overflow: hidden;
		background: #020817;
	}

	.panel--control {
		--cinder-surface: #0f172a;
		--cinder-surface-raised: #111f32;
		--cinder-surface-inset: #0b1422;
		--cinder-surface-hover: #17263a;
		--cinder-border: #334155;
		--cinder-border-muted: #1f2937;
		--cinder-border-strong: #4b647f;
		--cinder-text: #e2e8f0;
		--cinder-text-muted: #94a3b8;
		--cinder-text-subtle: #64748b;
		--cinder-text-disabled: #475569;
		--color-text-primary: #e2e8f0;
		--color-text-secondary: #cbd5e1;
		--color-text-muted: #94a3b8;
		--color-surface-subtle: #111827;
		--color-border: #334155;
		min-width: 0;
		border-right: none;
		padding: 1rem 1.125rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		background: #0f172a;
		color: var(--cinder-text, #e2e8f0);
	}

	.session-workbench[data-unusable='true'] .panel {
		opacity: 0.52;
	}

	.guided-tour-panel {
		border-bottom: 1px solid #334155;
		padding-bottom: 1.25rem;
	}

	.panel--control :global(.cinder-input),
	.panel--control :global(.cinder-number-input),
	.panel--control :global(.cinder-select) {
		background: #111f32;
		border-color: #334155;
		color: #e2e8f0;
	}

	.panel--control :global(.cinder-input-field__label),
	.panel--control :global(.cinder-select-field__label),
	.panel--control :global(label),
	.panel--control :global(h2),
	.panel--control :global(h3) {
		color: #e2e8f0;
	}

	.panel--control :global(p),
	.panel--control :global(li),
	.panel--control :global(dt),
	.panel--control :global(dd) {
		color: #cbd5e1;
	}

	.panel--control :global(.guided-tour__detail) {
		background: #111827;
		border-color: #334155;
	}

	.panel--control :global(.guided-tour__step--active) {
		color: #f8fafc;
	}

	@media (max-width: 64rem) {
		.workflow-state-grid {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(16rem, 0.65fr) minmax(28rem, 1fr);
			overflow-y: auto;
		}

		.panel--inspector {
			border-right: none;
			border-bottom: 1px solid #1f2937;
		}
	}

	@media (max-width: 42rem) {
		.session-header {
			flex-wrap: wrap;
		}

		.session-status {
			margin-left: 0;
		}

		.session-view-tabs {
			padding-inline: 0.5rem;
		}

		.session-view-tab {
			font-size: 0.8125rem;
			padding-inline: 0.65rem;
		}
	}
</style>
