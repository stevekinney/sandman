<script lang="ts">
	import EmptyState from '@lostgradient/cinder/empty-state';
	import '@lostgradient/cinder/empty-state/styles';
	import Editor from '$lib/components/editor/editor.svelte';
	import TemporalUiFrame from '$lib/components/temporal-ui/temporal-ui-frame.svelte';
	import ControlToolbar from '$lib/components/control-plane/control-toolbar.svelte';
	import TopologyStrip from '$lib/components/control-plane/topology-strip.svelte';
	import HistoryRail from '$lib/components/control-plane/history-rail.svelte';
	import {
		executionPointerFor,
		type CenterView
	} from '$lib/components/control-plane/session-actions';
	import type { SessionState } from '../../lib/components/control-plane/session-state.svelte.ts';
	import type { CodeReveal } from '$lib/components/editor/execution-pointer';
	import { GuidedTour, type TourState } from '$lib/components/explainer';
	import type { TourExperiment, TourLookAt } from '$lib/content/demo-script';
	import type { TourProgress } from '$lib/content/tour-engine';

	type HistoryLens = 'events' | 'steps';

	type Props = {
		session: SessionState;
		tourState: TourState;
		sandboxId: string;
		sandboxStatus: string;
		codeReveal: CodeReveal | null;
		centerView?: CenterView;
		historyLens?: HistoryLens;
		onShowExperimentCode: (experiment: TourExperiment) => void;
		onNavigateToLookAt: (lookAt: TourLookAt) => void;
	};

	let {
		session,
		tourState,
		sandboxId,
		sandboxStatus,
		codeReveal,
		centerView = $bindable('code'),
		historyLens = $bindable('events'),
		onShowExperimentCode,
		onNavigateToLookAt
	}: Props = $props();

	const tourProgress = $derived<TourProgress>({
		currentStepIndex: tourState.currentStepIndex,
		completedStepIds: [...tourState.completedStepIds]
	});
	const ctaEnabled = $derived(
		session.recommendedControl !== undefined && session.canDo(session.recommendedControl)
	);
	const execution = $derived(
		executionPointerFor(
			session.phase,
			session.workerOnline,
			session.workerRestarting,
			session.timelineEntries
		)
	);
</script>

<ControlToolbar {session} bind:view={centerView} />

<div class="session-workbench__body">
	<aside id="guided-journey" tabindex="-1" class="session-workbench__journey">
		<GuidedTour
			progress={tourProgress}
			{ctaEnabled}
			workerOnline={session.workerOnline}
			oncta={(control) => void session.dispatch(control)}
			onshowcode={onShowExperimentCode}
			onlookat={onNavigateToLookAt}
		/>
	</aside>

	<main class="session-workbench__center">
		<TopologyStrip {session} {sandboxStatus} />
		<div
			id="center-panel-code"
			role="tabpanel"
			aria-label="Code editor"
			class="session-workbench__panel"
			class:session-workbench__panel--hidden={centerView !== 'code'}
		>
			<Editor {sandboxId} {execution} reveal={codeReveal} />
		</div>
		<div
			id="center-panel-temporal"
			role="tabpanel"
			aria-label="Temporal Web UI"
			class="session-workbench__panel"
			class:session-workbench__panel--hidden={centerView !== 'temporal'}
		>
			{#if !session.serverOnline}
				<div class="session-workbench__server-down">
					<EmptyState
						title="Temporal Server is stopped"
						description="Its Web UI is down with it. Workflow state is persisted to disk - start the server from the topology strip to reconnect and resume."
					/>
				</div>
			{:else}
				{#key `${session.run?.workflowId ?? 'no-run'}:${session.serverOnline}`}
					<TemporalUiFrame {sandboxId} {sandboxStatus} />
				{/key}
			{/if}
		</div>
	</main>

	<div class="session-workbench__history">
		<HistoryRail {session} bind:lens={historyLens} />
	</div>
</div>

<style>
	.session-workbench__body {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.session-workbench__journey {
		flex: none;
		width: 20rem;
		min-height: 0;
		background: var(--cinder-surface);
		border-right: 1px solid var(--cinder-border);
	}

	.session-workbench__journey:focus {
		outline: 2px solid var(--cinder-accent);
		outline-offset: -2px;
	}

	.session-workbench__center {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--cinder-bg, #0b0f17);
	}

	.session-workbench__panel {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.session-workbench__panel > :global(*) {
		flex: 1;
		min-height: 0;
	}

	.session-workbench__panel--hidden {
		display: none;
	}

	.session-workbench__server-down {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 2rem;
	}

	.session-workbench__history {
		flex: none;
		width: 22rem;
		min-height: 0;
		background: var(--cinder-surface);
		border-left: 1px solid var(--cinder-border);
	}

	@media (max-width: 68rem) {
		.session-workbench__body {
			flex-direction: column;
			overflow: visible;
		}

		.session-workbench__journey,
		.session-workbench__history {
			width: auto;
			border-right: none;
			border-left: none;
			border-bottom: 1px solid var(--cinder-border);
		}

		.session-workbench__center {
			min-height: 32rem;
		}
	}
</style>
