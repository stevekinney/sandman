<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Progress from '@lostgradient/cinder/progress';
	import Steps from '@lostgradient/cinder/steps';
	import type { StepItem } from '@lostgradient/cinder/steps';
	import {
		getSandboxStartupProgress,
		getSandboxStatusFailureMessage,
		isSandboxStarting,
		isSandboxUnusable
	} from './session-status';

	type Props = {
		status: string;
		errorMessage: string | null;
		inviteRequired: boolean;
	};

	let { status, errorMessage, inviteRequired }: Props = $props();

	const starting = $derived(isSandboxStarting(status));
	const unavailable = $derived(isSandboxUnusable(status));
	const visible = $derived(starting || unavailable);
	const startupProgress = $derived(getSandboxStartupProgress(status));
	const failureMessage = $derived(getSandboxStatusFailureMessage(status, errorMessage));
	const readinessSteps = $derived<StepItem[]>(
		startupProgress.steps.map((step) => ({
			id: step.id,
			label: step.label,
			description: step.description
		}))
	);
	const currentReadinessStep = $derived(startupProgress.currentStepNumber - 1);
	const gateRole = $derived(starting ? 'status' : 'alert');
	const gateLive = $derived(starting ? 'polite' : 'assertive');
	const unavailableEyebrow = $derived(inviteRequired ? 'Session required' : 'Sandbox unavailable');
	const unavailableTitle = $derived(
		inviteRequired ? 'This sandbox link needs a session' : 'This sandbox is done'
	);
	const unavailableAction = $derived('Start a new session');
</script>

{#if visible}
	<div
		class="sandbox-readiness-gate session__gate"
		data-variant={starting ? 'starting' : 'unavailable'}
		role={gateRole}
		aria-live={gateLive}
	>
		<section class="sandbox-readiness-gate__panel" aria-label="Sandbox readiness">
			{#if starting}
				<p class="sandbox-readiness-gate__eyebrow">Sandbox starting</p>
				<h2 class="sandbox-readiness-gate__title">Starting sandbox</h2>
				<p class="sandbox-readiness-gate__copy">{startupProgress.currentStepDescription}</p>

				<div class="sandbox-readiness-gate__progress-row">
					<span id="sandbox-startup-progress-label">
						Step {startupProgress.currentStepNumber} of {startupProgress.totalStepCount}
					</span>
					<span>{startupProgress.percent}%</span>
				</div>
				<Progress
					class="sandbox-readiness-gate__progress"
					value={startupProgress.percent}
					label={startupProgress.currentStepDescription}
					ariaLabelledby="sandbox-startup-progress-label"
				/>

				<Steps
					steps={readinessSteps}
					currentStep={currentReadinessStep}
					orientation="vertical"
					label="Sandbox startup steps"
					class="sandbox-readiness-gate__steps"
				/>
			{:else}
				<p class="sandbox-readiness-gate__eyebrow">{unavailableEyebrow}</p>
				<h2 class="sandbox-readiness-gate__title">{unavailableTitle}</h2>
				<p class="sandbox-readiness-gate__copy">{failureMessage}</p>
				<Button href="/" label={unavailableAction} variant="primary" />
			{/if}
		</section>
	</div>
{/if}

<style>
	.sandbox-readiness-gate {
		position: absolute;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
		padding: 2rem;
		background: color-mix(in oklch, var(--cinder-bg, #0b0f17), transparent 28%);
		backdrop-filter: blur(2px);
	}

	.sandbox-readiness-gate__panel {
		width: min(31rem, 100%);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.375rem 1.5rem;
		border: 1px solid var(--cinder-border);
		border-radius: 0.5rem;
		background: var(--cinder-surface-raised);
		box-shadow: var(--cinder-shadow-lg);
		color: var(--cinder-text);
	}

	.sandbox-readiness-gate__eyebrow {
		margin: 0;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--cinder-color-warning-fg, #fbbf24);
	}

	.sandbox-readiness-gate__title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 750;
		line-height: 1.2;
	}

	.sandbox-readiness-gate__copy {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--cinder-text-muted);
	}

	.sandbox-readiness-gate__progress-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--cinder-text);
	}

	.sandbox-readiness-gate :global(.sandbox-readiness-gate__progress) {
		width: 100%;
	}

	.sandbox-readiness-gate :global(.sandbox-readiness-gate__steps) {
		margin-top: 0.25rem;
	}
</style>
