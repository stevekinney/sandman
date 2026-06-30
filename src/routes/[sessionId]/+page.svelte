<script lang="ts">
	/**
	 * +page.svelte — two-column Sandman session layout.
	 *
	 * Renders the demo as a two-column workbench:
	 *  - Left: code editor (code edit → hot-restart worker)
	 *  - Right: demo controls and guided tour above the Temporal Web UI
	 *
	 * The sandboxId from the URL param drives all three surfaces.
	 * Components degrade gracefully when no live sandbox is provisioned
	 * (editor saves fail with 503, Temporal UI shows startup/error states,
	 * API calls show errors).
	 */
	import type { PageData } from './$types';
	import type { WorkflowRun } from '$lib/components/control-plane/types';
	import type { TimelineEntry } from '$lib/contracts/workflow-api';
	import Editor from '$lib/components/editor/editor.svelte';
	import TemporalUiFrame from '$lib/components/temporal-ui/temporal-ui-frame.svelte';
	import ControlPlane from '$lib/components/control-plane/control-plane.svelte';
	import { FetchController } from '$lib/components/control-plane/fetch-controller';
	import { GuidedTour, TourState } from '$lib/components/explainer';
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
	const tourState = new TourState();

	// Live order timeline: poll `getTimeline` while a run is active and feed the
	// result to the control plane's `RunStepTimeline`. The control plane emits the
	// run via `onstarted` since it owns the start-order form.
	let run = $state<WorkflowRun | null>(null);
	let timelineEntries = $state<TimelineEntry[]>([]);
	let sandboxStatus = $state<string>('provisioning');
	let sandboxStatusError = $state<string | null>(null);
	const sandboxFailureMessage = $derived(
		getSandboxStatusFailureMessage(sandboxStatus, sandboxStatusError)
	);
	const sandboxUnusable = $derived(isSandboxUnusable(sandboxStatus));
	const inviteRequired = $derived(sandboxStatus === 'authentication-required');

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

	<main class="session-panels" data-unusable={sandboxUnusable}>
		<section class="panel panel--editor" aria-label="Code editor">
			<Editor sandboxId={data.sandboxId} />
		</section>

		<section class="panel panel--temporal-ui" aria-label="Temporal Web UI">
			<TemporalUiFrame sandboxId={data.sandboxId} {sandboxStatus} />
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

	.session-panels {
		display: grid;
		grid-template-columns: minmax(22rem, 0.92fr) minmax(32rem, 1.08fr);
		grid-template-rows: minmax(30rem, 1.2fr) minmax(18rem, 0.8fr);
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #020617;
	}

	.panel {
		min-height: 0;
		overflow: auto;
		border-right: 1px solid #1f2937;
	}

	.panel--editor {
		grid-row: 1 / span 2;
		overflow: hidden;
	}

	.panel--temporal-ui {
		grid-column: 2;
		grid-row: 2;
		min-width: 0;
		overflow: hidden;
		border-top: 1px solid #1f2937;
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
		grid-column: 2;
		grid-row: 1;
		padding: 1rem 1.125rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		background: #0f172a;
		color: var(--cinder-text, #e2e8f0);
	}

	.session-panels[data-unusable='true'] .panel {
		opacity: 0.52;
	}

	.guided-tour-panel {
		border-top: 1px solid #334155;
		padding-top: 1.25rem;
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
		.session-panels {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(22rem, 0.8fr) minmax(28rem, 1fr) minmax(22rem, 0.8fr);
		}

		.panel--editor,
		.panel--control,
		.panel--temporal-ui {
			grid-column: auto;
			grid-row: auto;
		}

		.panel {
			border-right: none;
			border-bottom: 1px solid #1f2937;
		}
	}
</style>
