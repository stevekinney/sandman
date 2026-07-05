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
	import { browser } from '$app/env';
	import type { PageData } from './$types';
	import type { ProcessLiveness } from '$lib/contracts/sandbox';
	import Alert from '@lostgradient/cinder/alert';
	import Button from '@lostgradient/cinder/button';
	import SkipLink from '@lostgradient/cinder/skip-link';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import ToastRegion from '@lostgradient/cinder/toast-region';
	import '@lostgradient/cinder/alert/styles';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/status-dot/styles';
	import '@lostgradient/cinder/toast-region/styles';
	import { FetchController } from '$lib/components/control-plane/fetch-controller';
	import { restoreSessionFromSandbox } from '$lib/components/control-plane/session-restore';
	import { SessionState } from '../../lib/components/control-plane/session-state.svelte.ts';
	import {
		orderStageDot,
		orderStageLabel,
		sandboxDot,
		workflowDot,
		workflowTag,
		type CenterView
	} from '$lib/components/control-plane/session-actions';
	import type { CodeReveal } from '$lib/components/editor/execution-pointer';
	import { TourState } from '$lib/components/explainer';
	import type { TourExperiment, TourLookAt } from '$lib/content/demo-script';
	import { localStorageAdapter } from '$lib/content/tour-engine';
	import type { StorageAdapter, TourProgress } from '$lib/content/tour-engine';
	import ToastBridge from './toast-bridge.svelte';
	import SandboxReadinessGate from './sandbox-readiness-gate.svelte';
	import SessionWorkbench from './session-workbench.svelte';
	import { SESSION_DESCRIPTION, SESSION_TITLE } from '$lib/metadata';
	import {
		getSandboxStatusDisplayLabel,
		getSandboxStatusFailureMessage,
		getSandboxStatusResponseFailureMessage,
		isSandboxStarting,
		isSandboxUnusable
	} from './session-status';

	let { data }: { data: PageData } = $props();

	// Tour progress persists per sandbox, so a reload resumes this sandbox's
	// journey and a new sandbox starts fresh. Always CONSTRUCT against a
	// throwaway in-memory adapter — on both SSR and the first client render —
	// so hydration's first paint matches the server exactly (no localStorage
	// read before mount to jump the tour ahead of what was server-rendered).
	// The effect below swaps in the real adapter and fast-forwards to any
	// persisted progress once mounted, client-side only.
	const tourState = $derived.by(() => {
		// Read data.sandboxId to key this derived on it, even though the
		// constructor below doesn't need the value directly. Without this,
		// tourState reads nothing reactive and would never recreate — so
		// navigating client-side between two sandboxes (SvelteKit reuses this
		// component across the [sessionId] param) would keep the previous
		// sandbox's tour instance alive. advanceTo is forward-only, so the
		// stuck-behind tour could never load the new sandbox's saved progress,
		// and the next persist write would overwrite it with the wrong state.
		void data.sandboxId;
		return new TourState(createVolatileTourStorage());
	});
	const controller = $derived(new FetchController(data.sandboxId));
	const session = $derived(new SessionState(controller, tourState));

	/** Where this sandbox's most recently known active workflow id lives. */
	function activeWorkflowIdKey(sandboxId: string): string {
		return `sandman:active-workflow:${sandboxId}`;
	}

	/** The workflow id this sandbox was last attached to, if any. */
	function readPreferredWorkflowId(sandboxId: string): string | undefined {
		try {
			return localStorage.getItem(activeWorkflowIdKey(sandboxId)) ?? undefined;
		} catch {
			return undefined;
		}
	}

	// Client-only: attach real persistence after the first (SSR-matching)
	// render, then fast-forward to whatever progress was already saved.
	$effect(() => {
		if (!browser) return;
		const storage = localStorageAdapter(`sandman:tour:${data.sandboxId}`);
		const saved = storage.load();
		if (saved) tourState.advanceTo(saved.currentStepIndex);
		tourState.replaceStorage(storage);
	});

	// Track the sandbox's most recently active workflow id so a reload can
	// disambiguate which run to restore if more than one is running (Reset is
	// client-only and does not cancel the workflow, so an old run can still be
	// live when the learner starts a new one). Wired as SessionState.onRunChanged
	// — called synchronously at every mutation site — rather than a reactive
	// $effect on `session.run`: an effect flushes a tick later, leaving a
	// window where a reload could race ahead of the write and read a stale id.
	$effect(() => {
		const activeSession = session;
		const sandboxId = data.sandboxId;
		activeSession.onRunChanged = (run) => {
			if (!browser) return;
			const key = activeWorkflowIdKey(sandboxId);
			try {
				if (run) localStorage.setItem(key, run.workflowId);
				else localStorage.removeItem(key);
			} catch {
				// Quota exceeded or private-browsing restriction — fail silently,
				// matching localStorageAdapter's own tolerance for this.
			}
		};
	});

	let sandboxStatus = $state<string>('provisioning');
	let sandboxStatusError = $state<string | null>(null);
	let sandboxExpiresAt = $state<string | null>(null);
	let clockMs = $state(Date.now());
	let centerView = $state<CenterView>('code');
	let historyLens = $state<'events' | 'steps'>('events');
	let codeReveal = $state<CodeReveal | null>(null);

	// The session self-destructs after its TTL (default ~5 min), and that window
	// slides forward on activity. Surface it as a live countdown so a presenter
	// can pace a demo instead of being cut off mid-sentence.
	const sessionRemainingMs = $derived(
		sandboxExpiresAt !== null ? Math.max(0, Date.parse(sandboxExpiresAt) - clockMs) : null
	);
	const sessionCountdown = $derived(formatCountdown(sessionRemainingMs));
	const sessionEndingSoon = $derived(sessionRemainingMs !== null && sessionRemainingMs < 60_000);

	/** Format a remaining-milliseconds value as `m:ss`, or null when unknown. */
	function formatCountdown(remainingMs: number | null): string | null {
		if (remainingMs === null) return null;
		const totalSeconds = Math.floor(remainingMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}

	// Tick a wall-clock every second so the countdown updates. This is an external
	// time source, not derived state, so an interval-in-effect is the right tool.
	$effect(() => {
		const handle = setInterval(() => {
			clockMs = Date.now();
		}, 1000);
		return () => clearInterval(handle);
	});

	const sandboxFailureMessage = $derived(
		getSandboxStatusFailureMessage(sandboxStatus, sandboxStatusError)
	);
	const sandboxUnusable = $derived(isSandboxUnusable(sandboxStatus));
	const sandboxStarting = $derived(isSandboxStarting(sandboxStatus));
	const sandboxBlocked = $derived(sandboxStarting || sandboxUnusable);
	const inviteRequired = $derived(sandboxStatus === 'authentication-required');

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
					expiresAt?: string | null;
					processes?: ProcessLiveness | null;
				};
				if (!cancelled) {
					sandboxStatus = payload.status;
					sandboxStatusError = payload.errorMessage;
					sandboxExpiresAt = payload.expiresAt ?? null;
					activeSession.sandboxUsable = payload.status === 'ready';
					// Backend process liveness is authoritative; reconcile so the
					// topology survives reloads and editor save-restarts. Absent or
					// `null` means "unknown" (handle gone) — leave the current value.
					if (payload.processes) {
						activeSession.reconcileLiveness(payload.processes);
					}
					// Piggyback the reload restore on this poll's cadence rather than a
					// separate effect: restoreSessionFromSandbox is a cheap no-op once
					// it has a run, so this naturally retries a transient Visibility
					// failure (e.g. a blip that doesn't otherwise change these flags)
					// without a dedicated timer.
					if (activeSession.sandboxUsable && activeSession.serverOnline) {
						void restoreSessionFromSandbox(
							controller,
							activeSession,
							readPreferredWorkflowId(sandboxId)
						);
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

	/** In-memory StorageAdapter used only for the SSR pass. */
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

<SkipLink target="guided-journey">Skip to guided journey</SkipLink>

<ToastRegion position="bottom-center">
	<ToastBridge
		register={(api) => {
			session.notify = (message, variant) => api.show(message, { variant });
		}}
	/>

	<div class="session" data-theme="dark" data-unusable={sandboxUnusable}>
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
			{#if sessionCountdown !== null && !sandboxBlocked}
				<div
					class="session__chip session__chip--countdown"
					data-ending-soon={sessionEndingSoon}
					title="Time left before this ephemeral sandbox self-destructs"
				>
					<span class="session__chip-name">Session</span>
					<!-- No aria-live: the value re-renders every second, and announcing
					     each tick would flood screen readers with noise. -->
					<span class="session__chip-value">{sessionCountdown} left</span>
				</div>
			{/if}
			<span class="session__id" title="Sandbox ID">{data.sandboxId}</span>
			<Button
				variant="soft-danger"
				size="sm"
				label="Reset"
				class="session__reset"
				disabled={sandboxBlocked}
				onclick={() => session.reset()}
			/>
		</header>

		{#if sandboxFailureMessage && !sandboxUnusable}
			<Alert variant="danger" class="session__alert">
				<span class="session__alert-copy">{sandboxFailureMessage}</span>
			</Alert>
		{/if}

		<div class="session__workbench-shell">
			<div
				class="session__workbench"
				data-blocked={sandboxBlocked}
				inert={sandboxBlocked}
				aria-busy={sandboxStarting}
			>
				<SessionWorkbench
					{session}
					{tourState}
					sandboxId={data.sandboxId}
					{sandboxStatus}
					{codeReveal}
					bind:centerView
					bind:historyLens
					onShowExperimentCode={showExperimentCode}
					onNavigateToLookAt={navigateToLookAt}
				/>
			</div>
			<SandboxReadinessGate
				status={sandboxStatus}
				errorMessage={sandboxStatusError}
				{inviteRequired}
			/>
		</div>
	</div>
</ToastRegion>

<style>
	.session {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		color-scheme: dark;
		background: var(--cinder-bg, #0b0f17);
		color: var(--cinder-text, #e5e7eb);
		font-size: 0.875rem;
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

	.session__chip--countdown .session__chip-value {
		font-variant-numeric: tabular-nums;
		font-weight: 650;
	}

	.session__chip--countdown[data-ending-soon='true'] {
		border-color: var(--cinder-color-danger-border, var(--cinder-danger));
		background: color-mix(in oklch, var(--cinder-danger), transparent 88%);
	}

	.session__chip--countdown[data-ending-soon='true'] .session__chip-value {
		color: var(--cinder-danger);
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

	.session__workbench-shell {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.session__workbench {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		transition:
			opacity 160ms ease,
			filter 160ms ease;
	}

	.session__workbench[data-blocked='true'] {
		opacity: 0.28;
		filter: saturate(0.35) brightness(0.72);
		pointer-events: none;
		user-select: none;
	}

	@media (max-width: 68rem) {
		.session {
			height: auto;
			min-height: 100dvh;
			overflow: auto;
		}
	}
</style>
