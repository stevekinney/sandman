<script lang="ts">
	/**
	 * +page.svelte — three-surface Sandman session layout.
	 *
	 * Renders the demo side-by-side:
	 *  - Left:   Monaco editor (code edit → hot-restart worker)
	 *  - Centre: Temporal Web UI (reverse-proxied iframe via Track B)
	 *  - Right:  Control plane (signals/queries/updates/chaos) + guided tour
	 *
	 * The sandboxId from the URL param drives all three surfaces.
	 * Components degrade gracefully when no live sandbox is provisioned
	 * (editor saves fail with 503, iframe shows 502, API calls show errors).
	 */
	import type { PageData } from './$types';
	import type { WorkflowRun } from '$lib/components/control-plane/types';
	import type { TimelineEntry } from '$lib/contracts/workflow-api';
	import Editor from '$lib/components/editor/editor.svelte';
	import TemporalUiFrame from '$lib/components/temporal-ui/temporal-ui-frame.svelte';
	import ControlPlane from '$lib/components/control-plane/control-plane.svelte';
	import { FetchController } from '$lib/components/control-plane/fetch-controller';
	import { GuidedTour, TourState } from '$lib/components/explainer';

	let { data }: { data: PageData } = $props();

	const controller = $derived(new FetchController(data.sandboxId));
	const tourState = new TourState();

	// Live order timeline: poll `getTimeline` while a run is active and feed the
	// result to the control plane's `RunStepTimeline`. The control plane emits the
	// run via `onstarted` since it owns the start-order form.
	let run = $state<WorkflowRun | null>(null);
	let timelineEntries = $state<TimelineEntry[]>([]);
	let sandboxStatus = $state<string>('provisioning');
	let sandboxStatusError = $state<string | null>(null);

	$effect(() => {
		const sandboxId = data.sandboxId;
		let cancelled = false;

		async function pollStatus(): Promise<void> {
			try {
				const response = await fetch(`/api/sandbox/${sandboxId}/status`);
				if (!response.ok) {
					if (!cancelled) sandboxStatusError = await response.text();
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
		if (run === null) return;
		const workflowId = run.workflowId;
		let cancelled = false;

		async function poll(): Promise<void> {
			try {
				const entries = await activeController.query(workflowId, 'getTimeline');
				if (!cancelled && Array.isArray(entries)) timelineEntries = entries;
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
</script>

<div class="sandman-session">
	<header class="session-header">
		<h1 class="session-title">Sandman</h1>
		<span class="session-id" title="Sandbox ID">{data.sandboxId}</span>
		<span class="session-status" data-status={sandboxStatus}>{sandboxStatus}</span>
	</header>

	{#if sandboxStatus === 'error' || sandboxStatusError}
		<div class="session-error" role="alert">
			{sandboxStatusError ?? 'Sandbox bootstrap failed. Start a new session to try again.'}
		</div>
	{/if}

	<main class="session-panels">
		<section class="panel panel--editor" aria-label="Code editor">
			<Editor sandboxId={data.sandboxId} />
		</section>

		<section class="panel panel--temporal-ui" aria-label="Temporal Web UI">
			<TemporalUiFrame sandboxId={data.sandboxId} />
		</section>

		<aside class="panel panel--control" aria-label="Control plane and guided tour">
			<ControlPlane {controller} {timelineEntries} onstarted={(r) => (run = r)} />
			<div class="guided-tour-panel">
				<GuidedTour
					progress={{
						currentStepIndex: tourState.currentStepIndex,
						completedStepIds: [...tourState.completedStepIds]
					}}
					onreset={() => tourState.reset()}
				/>
			</div>
		</aside>
	</main>
</div>

<style>
	.sandman-session {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.session-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem 1rem;
		background: #1e1e1e;
		color: #ccc;
		border-bottom: 1px solid #333;
		flex-shrink: 0;
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
		color: #888;
	}

	.session-status {
		margin-left: auto;
		border: 1px solid #4b5563;
		border-radius: 999px;
		padding: 0.2rem 0.55rem;
		font-size: 0.75rem;
		text-transform: capitalize;
		color: #d1d5db;
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
		background: #fef2f2;
		border-bottom: 1px solid #fecaca;
		color: #991b1b;
		padding: 0.6rem 1rem;
		font-size: 0.875rem;
	}

	.session-panels {
		display: grid;
		grid-template-columns: 1fr 1fr 380px;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.panel {
		min-height: 0;
		overflow: auto;
		border-right: 1px solid #333;
	}

	.panel--editor {
		overflow: hidden;
	}

	.panel--temporal-ui {
		overflow: hidden;
	}

	.panel--control {
		border-right: none;
		padding: 1rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		background: #fafafa;
	}

	.guided-tour-panel {
		border-top: 1px solid #e5e7eb;
		padding-top: 1.5rem;
	}
</style>
