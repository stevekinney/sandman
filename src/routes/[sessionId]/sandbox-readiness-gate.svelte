<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import '@lostgradient/cinder/button/styles';
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
	const gateRole = $derived(starting ? 'status' : 'alert');
	const gateLive = $derived(starting ? 'polite' : 'assertive');
	const unavailableEyebrow = $derived(
		inviteRequired ? 'Invite session required' : 'Sandbox unavailable'
	);
	const unavailableTitle = $derived(
		inviteRequired ? 'This sandbox link needs a session' : 'This sandbox is done'
	);
	const unavailableAction = $derived(inviteRequired ? 'Enter invite code' : 'Start a new session');
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
					<span>
						Step {startupProgress.currentStepNumber} of {startupProgress.totalStepCount}
					</span>
					<span>{startupProgress.percent}%</span>
				</div>
				<progress
					class="sandbox-readiness-gate__progress"
					value={startupProgress.percent}
					max="100"
					aria-label="Sandbox startup progress"
				>
					{startupProgress.percent}%
				</progress>

				<ol class="sandbox-readiness-gate__steps">
					{#each startupProgress.steps as step (step.id)}
						<li class="sandbox-readiness-gate__step" data-state={step.state}>
							<span class="sandbox-readiness-gate__step-dot" aria-hidden="true"></span>
							<span>
								<span class="sandbox-readiness-gate__step-label">{step.label}</span>
								<span class="sandbox-readiness-gate__step-description">{step.description}</span>
							</span>
						</li>
					{/each}
				</ol>
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

	.sandbox-readiness-gate__progress {
		width: 100%;
		height: 0.5rem;
		overflow: hidden;
		border: none;
		border-radius: 999px;
		background: var(--cinder-surface-inset);
	}

	.sandbox-readiness-gate__progress::-webkit-progress-bar {
		background: var(--cinder-surface-inset);
	}

	.sandbox-readiness-gate__progress::-webkit-progress-value {
		border-radius: 999px;
		background: linear-gradient(90deg, var(--cinder-accent), #38bdf8);
	}

	.sandbox-readiness-gate__progress::-moz-progress-bar {
		border-radius: 999px;
		background: linear-gradient(90deg, var(--cinder-accent), #38bdf8);
	}

	.sandbox-readiness-gate__steps {
		display: grid;
		gap: 0.625rem;
		margin: 0.25rem 0 0;
		padding: 0;
		list-style: none;
	}

	.sandbox-readiness-gate__step {
		display: grid;
		grid-template-columns: 0.75rem 1fr;
		gap: 0.625rem;
		align-items: start;
		color: var(--cinder-text-subtle);
	}

	.sandbox-readiness-gate__step[data-state='complete'] {
		color: var(--cinder-color-success-fg, #86efac);
	}

	.sandbox-readiness-gate__step[data-state='current'] {
		color: var(--cinder-text);
	}

	.sandbox-readiness-gate__step-dot {
		width: 0.625rem;
		height: 0.625rem;
		margin-top: 0.25rem;
		border: 2px solid currentColor;
		border-radius: 999px;
		background: transparent;
	}

	.sandbox-readiness-gate__step[data-state='complete'] .sandbox-readiness-gate__step-dot,
	.sandbox-readiness-gate__step[data-state='current'] .sandbox-readiness-gate__step-dot {
		background: currentColor;
	}

	.sandbox-readiness-gate__step-label,
	.sandbox-readiness-gate__step-description {
		display: block;
	}

	.sandbox-readiness-gate__step-label {
		font-size: 0.8125rem;
		font-weight: 700;
		color: currentColor;
	}

	.sandbox-readiness-gate__step-description {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--cinder-text-muted);
	}

	.sandbox-readiness-gate__step[data-state='upcoming'] .sandbox-readiness-gate__step-description {
		color: var(--cinder-text-subtle);
	}
</style>
