<script lang="ts">
	/**
	 * +page.svelte — the single-screen Temporal Sandbox workbench.
	 *
	 * Layout (per the "Temporal sandbox UI redesign" Claude Design project):
	 *  - Status bar: sandbox / order / workflow chips and a global Reset.
	 *  - Control toolbar: one-click Temporal controls + Code / Temporal UI switch.
	 *  - Left rail: the guided journey (event-driven tour with a CTA).
	 *  - Center: client → server → worker topology strip above the live code
	 *    editor (save = hot-restart worker) or the proxied Temporal Web UI.
	 *  - Right rail: workflow history as a live event stream or friendly steps.
	 *  - Toasts (bottom center) narrate recoveries, rejections, and results.
	 *
	 * All surfaces are driven by the real sandbox APIs and degrade gracefully
	 * while the sandbox is provisioning or unusable.
	 */
	import type { PageData } from './$types';
	import type { ProcessLiveness } from '$lib/contracts/sandbox';
	import Alert from '@lostgradient/cinder/alert';
	import Button from '@lostgradient/cinder/button';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import ToastRegion from '@lostgradient/cinder/toast-region';
	import '@lostgradient/cinder/alert/styles';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/status-dot/styles';
	import '@lostgradient/cinder/toast-region/styles';
	import Editor from '$lib/components/editor/editor.svelte';
	import TemporalUiFrame from '$lib/components/temporal-ui/temporal-ui-frame.svelte';
	import ControlToolbar from '$lib/components/control-plane/control-toolbar.svelte';
	import TopologyStrip from '$lib/components/control-plane/topology-strip.svelte';
	import HistoryRail from '$lib/components/control-plane/history-rail.svelte';
	import { FetchController } from '$lib/components/control-plane/fetch-controller';
	import { SessionState } from '../../lib/components/control-plane/session-state.svelte.ts';
	import {
		executionPointerFor,
		orderStageDot,
		orderStageLabel,
		sandboxDot,
		workflowDot,
		workflowTag,
		type CenterView
	} from '$lib/components/control-plane/session-actions';
	import type { CodeReveal } from '$lib/components/editor/execution-pointer';
	import { GuidedTour, TourState } from '$lib/components/explainer';
	import type { TourExperiment, TourLookAt } from '$lib/content/demo-script';
	import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
	import EmptyState from '@lostgradient/cinder/empty-state';
	import '@lostgradient/cinder/empty-state/styles';
	import ToastBridge from './toast-bridge.svelte';
	import { SESSION_DESCRIPTION, SESSION_TITLE } from '$lib/metadata';
	import {
		getSandboxStatusDisplayLabel,
		getSandboxStatusFailureMessage,
		getSandboxStatusResponseFailureMessage,
		isSandboxUnusable
	} from './session-status';

	let { data }: { data: PageData } = $props();

	const tourState = new TourState(createVolatileTourStorage());
	const session = $derived(new SessionState(new FetchController(data.sandboxId), tourState));

	let sandboxStatus = $state<string>('provisioning');
	let sandboxStatusError = $state<string | null>(null);
	let centerView = $state<CenterView>('code');
	let historyLens = $state<'events' | 'steps'>('events');
	let codeReveal = $state<CodeReveal | null>(null);

	const sandboxFailureMessage = $derived(
		getSandboxStatusFailureMessage(sandboxStatus, sandboxStatusError)
	);
	const sandboxUnusable = $derived(isSandboxUnusable(sandboxStatus));
	const inviteRequired = $derived(sandboxStatus === 'authentication-required');
	const tourProgress = $derived<TourProgress>({
		currentStepIndex: tourState.currentStepIndex,
		completedStepIds: [...tourState.completedStepIds]
	});
	const ctaEnabled = $derived(
		session.recommendedControl !== undefined && session.canDo(session.recommendedControl)
	);
	const execution = $derived(
		executionPointerFor(session.phase, session.workerOnline, session.workerRestarting)
	);

	/** Jump the editor to an experiment's code and flash the anchor line. */
	function showExperimentCode(experiment: TourExperiment): void {
		centerView = 'code';
		codeReveal = {
			file: experiment.file,
			anchor: experiment.anchor,
			nonce: (codeReveal?.nonce ?? 0) + 1
		};
	}

	/** Navigate to the surface a tour step's "where to look" callout names. */
	function navigateToLookAt(lookAt: TourLookAt): void {
		if (lookAt.surface === 'temporal-ui') {
			centerView = 'temporal';
			return;
		}
		historyLens = lookAt.surface;
	}

	// Poll the sandbox status so the chips, banner, and control gating stay live.
	$effect(() => {
		const sandboxId = data.sandboxId;
		const activeSession = session;
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
						activeSession.sandboxUsable = false;
					}
					return;
				}
				const payload = (await response.json()) as {
					status: string;
					errorMessage: string | null;
					processes?: ProcessLiveness | null;
				};
				if (!cancelled) {
					sandboxStatus = payload.status;
					sandboxStatusError = payload.errorMessage;
					activeSession.sandboxUsable = payload.status === 'ready';
					// Backend process liveness is authoritative; reconcile so the
					// topology survives reloads and editor save-restarts. Absent or
					// `null` means "unknown" (handle gone) — leave the current value.
					if (payload.processes) {
						activeSession.reconcileLiveness(payload.processes);
					}
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

	// Poll `getTimeline` while a run is active — queries execute on the worker,
	// so polling pauses while the worker is down and resumes after restart.
	$effect(() => {
		const activeSession = session;
		const run = activeSession.run;
		if (run === null || !activeSession.workerOnline) return;
		const workflowId = run.workflowId;
		const controller = new FetchController(data.sandboxId);
		let cancelled = false;

		async function poll(): Promise<void> {
			try {
				const entries = await controller.query(workflowId, 'getTimeline');
				if (!cancelled && Array.isArray(entries)) activeSession.ingestTimeline(entries);
			} catch {
				// No live worker yet — keep the last known entries.
			}
		}

		void poll();
		const handle = setInterval(() => void poll(), 2000);
		return () => {
			cancelled = true;
			clearInterval(handle);
		};
	});

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

	function focusGuidedJourney(event: MouseEvent): void {
		event.preventDefault();
		const target = document.getElementById('guided-journey');
		if (target === null) return;
		target.focus();
		target.scrollIntoView({ block: 'start' });
		history.replaceState(null, '', '#guided-journey');
	}
</script>

<svelte:head>
	<title>{SESSION_TITLE}</title>
	<meta name="description" content={SESSION_DESCRIPTION} />
	<!-- Session URLs are ephemeral, invite-gated, and unguessable — keep them
	     out of search indexes while still unfurling nicely when shared. -->
	<meta name="robots" content="noindex, nofollow" />
	<meta property="og:title" content={SESSION_TITLE} />
	<meta property="og:description" content={SESSION_DESCRIPTION} />
	<meta name="twitter:title" content={SESSION_TITLE} />
	<meta name="twitter:description" content={SESSION_DESCRIPTION} />
</svelte:head>

<ToastRegion position="bottom-center">
	<ToastBridge
		register={(api) => {
			session.notify = (message, variant) => api.show(message, { variant });
		}}
	/>

	<div class="session" data-theme="dark" data-unusable={sandboxUnusable}>
		<a class="skip-link" href="#guided-journey" onclick={focusGuidedJourney}>
			Skip to guided journey
		</a>

		<header class="session__bar">
			<h1 class="session__brand">Sandman</h1>
			<div class="session__chip" data-chip="sandbox">
				<StatusDot status={sandboxDot(sandboxStatus)} label="Sandbox status" showLabel={false} />
				<span class="session__chip-name">Sandbox</span>
				<span class="session__chip-value">{getSandboxStatusDisplayLabel(sandboxStatus)}</span>
			</div>
			<div class="session__chip" data-chip="order">
				<StatusDot status={orderStageDot(session.phase)} label="Order stage" showLabel={false} />
				<span class="session__chip-name">Order</span>
				<span class="session__chip-value">{orderStageLabel(session.phase)}</span>
			</div>
			<div class="session__chip" data-chip="workflow">
				<StatusDot status={workflowDot(session.phase)} label="Workflow status" showLabel={false} />
				<span class="session__chip-name">Workflow</span>
				<span class="session__chip-value">{workflowTag(session.phase)}</span>
			</div>
			<span class="session__id" title="Sandbox ID">{data.sandboxId}</span>
			<Button
				variant="soft-danger"
				size="sm"
				label="Reset"
				class="session__reset"
				onclick={() => session.reset()}
			/>
		</header>

		{#if sandboxFailureMessage && !sandboxUnusable}
			<Alert variant="danger" class="session__alert">
				<span class="session__alert-copy">{sandboxFailureMessage}</span>
			</Alert>
		{/if}

		<ControlToolbar {session} bind:view={centerView} />

		{#if sandboxUnusable}
			<!-- The workbench below is inert; a centered gate explains why and
			     offers the way back instead of a screaming full-width banner. -->
			<div class="session__gate" role="alert">
				<div class="session__gate-card">
					<p class="session__gate-eyebrow">
						{inviteRequired ? 'Invite session required' : 'Sandbox unavailable'}
					</p>
					<h2 class="session__gate-title">
						{inviteRequired ? 'This sandbox link needs a session' : 'This sandbox is done'}
					</h2>
					<p class="session__gate-copy">{sandboxFailureMessage}</p>
					<Button
						href="/"
						label={inviteRequired ? 'Enter invite code' : 'Start a new session'}
						variant="primary"
					/>
				</div>
			</div>
		{/if}

		<div class="session__body">
			<aside id="guided-journey" tabindex="-1" class="session__journey">
				<GuidedTour
					progress={tourProgress}
					{ctaEnabled}
					workerOnline={session.workerOnline}
					oncta={(control) => void session.dispatch(control)}
					onshowcode={showExperimentCode}
					onlookat={navigateToLookAt}
				/>
			</aside>

			<main class="session__center">
				<TopologyStrip {session} {sandboxStatus} />
				<!-- Both panels stay mounted so Monaco and the Temporal UI iframe
				     keep their state across view switches; CSS hides the inactive one. -->
				<div
					id="center-panel-code"
					role="tabpanel"
					aria-label="Code editor"
					class="session__panel"
					class:session__panel--hidden={centerView !== 'code'}
				>
					<Editor sandboxId={data.sandboxId} {execution} reveal={codeReveal} />
				</div>
				<div
					id="center-panel-temporal"
					role="tabpanel"
					aria-label="Temporal Web UI"
					class="session__panel"
					class:session__panel--hidden={centerView !== 'temporal'}
				>
					{#if !session.serverOnline}
						<div class="session__server-down">
							<EmptyState
								title="Temporal Server is stopped"
								description="Its Web UI is down with it. Workflow state is persisted to disk — start the server from the topology strip to reconnect and resume."
							/>
						</div>
					{:else}
						<!-- Keyed by run + server lifecycle so the embedded UI reloads with a
						     fresh workflow list instead of showing a stale pre-run snapshot. -->
						{#key `${session.run?.workflowId ?? 'no-run'}:${session.serverOnline}`}
							<TemporalUiFrame sandboxId={data.sandboxId} {sandboxStatus} />
						{/key}
					{/if}
				</div>
			</main>

			<div class="session__history">
				<HistoryRail {session} bind:lens={historyLens} />
			</div>
		</div>
	</div>
</ToastRegion>

<style>
	.session {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		color-scheme: dark;
		background: var(--cinder-bg, #0b0f17);
		color: var(--cinder-text, #e5e7eb);
		font-size: 0.875rem;
	}

	.skip-link {
		position: fixed;
		top: 0.75rem;
		left: 0.75rem;
		z-index: 1000;
		transform: translateY(-150%);
		border: 1px solid var(--cinder-accent);
		border-radius: 0.375rem;
		background: var(--cinder-surface-raised);
		color: var(--cinder-text);
		padding: 0.55rem 0.75rem;
		font-size: 0.875rem;
		font-weight: 700;
		text-decoration: none;
	}

	.skip-link:focus {
		transform: translateY(0);
		outline: 2px solid var(--cinder-accent);
		outline-offset: 2px;
	}

	.session__bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem 1rem;
		background: var(--cinder-surface);
		border-bottom: 1px solid var(--cinder-border);
	}

	.session__brand {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 800;
		color: var(--cinder-text);
	}

	.session__chip {
		display: flex;
		align-items: center;
		gap: 0.4375rem;
		padding: 0.3125rem 0.625rem;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: 0.5rem;
	}

	.session__chip-name {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--cinder-text);
	}

	.session__chip-value {
		font-size: 0.6875rem;
		color: var(--cinder-text-muted);
	}

	.session__id {
		margin-left: auto;
		font-family: var(--cinder-font-mono, monospace);
		font-size: 0.6875rem;
		color: var(--cinder-text-subtle);
	}

	.session :global(.session__alert) {
		border-radius: 0;
	}

	.session__alert-copy {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.75rem;
		align-items: baseline;
		min-width: 0;
	}

	.session__body {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.session__journey {
		flex: none;
		width: 20rem;
		min-height: 0;
		background: var(--cinder-surface);
		border-right: 1px solid var(--cinder-border);
	}

	.session__journey:focus {
		outline: 2px solid var(--cinder-accent);
		outline-offset: -2px;
	}

	.session__center {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--cinder-bg, #0b0f17);
	}

	.session__panel {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.session__panel > :global(*) {
		flex: 1;
		min-height: 0;
	}

	.session__panel--hidden {
		display: none;
	}

	.session__server-down {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 2rem;
	}

	.session__history {
		flex: none;
		width: 22rem;
		min-height: 0;
		background: var(--cinder-surface);
		border-left: 1px solid var(--cinder-border);
	}

	.session[data-unusable='true'] .session__body {
		opacity: 0.35;
		filter: saturate(0.4);
		pointer-events: none;
		user-select: none;
	}

	.session__gate {
		position: absolute;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
		padding: 2rem;
		background: color-mix(in oklch, var(--cinder-bg, #0b0f17), transparent 35%);
		backdrop-filter: blur(2px);
	}

	.session {
		position: relative;
	}

	.session__gate-card {
		max-width: 26rem;
		padding: 1.5rem 1.625rem;
		border: 1px solid var(--cinder-border);
		border-radius: 0.875rem;
		background: var(--cinder-surface-raised);
		box-shadow: var(--cinder-shadow-lg);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		align-items: flex-start;
	}

	.session__gate-eyebrow {
		margin: 0;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--cinder-color-warning-fg, #fbbf24);
	}

	.session__gate-title {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 750;
		line-height: 1.25;
		color: var(--cinder-text);
	}

	.session__gate-copy {
		margin: 0 0 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--cinder-text-muted);
	}

	@media (max-width: 68rem) {
		.session {
			height: auto;
			min-height: 100dvh;
			overflow: auto;
		}

		.session__body {
			flex-direction: column;
			overflow: visible;
		}

		.session__journey,
		.session__history {
			width: auto;
			border-right: none;
			border-left: none;
			border-bottom: 1px solid var(--cinder-border);
		}

		.session__center {
			min-height: 32rem;
		}
	}
</style>
