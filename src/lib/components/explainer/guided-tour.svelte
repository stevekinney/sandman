<script lang="ts">
	/**
	 * guided-tour.svelte — the "Guided journey" rail.
	 *
	 * Shows the current tour step as a card (concept eyebrow, title, copy, a
	 * "watch for this" line, and a call-to-action button when the step is driven
	 * by a control), plus the full ordered step list beneath it. Progress is
	 * event-driven: the parent advances `progress` as workflow events arrive.
	 *
	 * Uses a plain accessible ordered list because the tour can skip past steps
	 * that should not be announced or styled as completed. Cinder tracking:
	 * https://github.com/stevekinney/cinder/issues/655
	 */
	import Button from '@lostgradient/cinder/button';
	import Spinner from '@lostgradient/cinder/spinner';
	import MarkdownText from './markdown-text.svelte';
	import type { TourProgress } from '$lib/content/tour-engine';
	import { TOUR } from '$lib/content/demo-script';
	import type { TourExperiment, TourLookAt } from '$lib/content/demo-script';
	import type { ControlId } from '$lib/contracts/workflow-api';

	type Props = {
		/** Current progress snapshot; controls which step is active. */
		progress: TourProgress;
		/** Whether the current step's control can run right now. */
		ctaEnabled?: boolean;
		/**
		 * Why the current step's control is disabled right now, if it is. Shown
		 * beneath a disabled CTA so a gated step never becomes a silent dead-end.
		 */
		ctaBlockedReason?: string;
		/**
		 * True when the workflow has reached a terminal phase that can never
		 * fire the current step's completing event. Replaces the CTA with an
		 * inline "skip / restart" affordance so the step is never stuck forever.
		 */
		stepStuck?: boolean;
		/** Worker liveness — flips the kill-worker CTA label to "Restart". */
		workerOnline?: boolean;
		/** Called when the user clicks the step's call-to-action button. */
		oncta?: (control: ControlId) => void;
		/** Called when the user skips a step that can no longer complete. */
		onskip?: () => void;
		/** Called when the user restarts the tour from a stuck step. */
		onrestart?: () => void;
		/** Called when the user asks to see an experiment's code in the editor. */
		onshowcode?: (experiment: TourExperiment) => void;
		/** Called when the user asks to be taken to a "where to look" surface. */
		onlookat?: (lookAt: TourLookAt) => void;
	};

	let {
		progress,
		ctaEnabled = false,
		ctaBlockedReason,
		stepStuck = false,
		workerOnline = true,
		oncta,
		onskip,
		onrestart,
		onshowcode,
		onlookat
	}: Props = $props();

	function lookAtButtonLabel(surface: TourLookAt['surface']): string {
		switch (surface) {
			case 'temporal-ui':
				return 'Open the Temporal UI';
			case 'events':
				return 'Show the event stream';
			case 'steps':
				return 'Show the friendly steps';
		}
		const exhaustive: never = surface;
		return exhaustive;
	}

	const activeStep = $derived(progress.currentStepIndex);
	const isComplete = $derived(activeStep >= TOUR.length);
	const currentStep = $derived(TOUR[activeStep]);
	const ctaControl = $derived(isComplete ? undefined : currentStep?.control);

	function getActionLabel(control: ControlId): string {
		switch (control) {
			case 'start-order':
				return 'Place order';
			case 'cancel-order':
				return 'Cancel order';
			case 'accept-restaurant':
				return 'Send restaurant-accepted signal';
			case 'reject-restaurant':
				return 'Send restaurant-rejected signal';
			case 'food-ready':
				return 'Mark food ready';
			case 'update-location':
				return 'Update courier location';
			case 'add-tip':
				return 'Add tip';
			case 'update-address':
				return 'Update delivery address';
			case 'apply-promo':
				return 'Apply promo code';
			case 'query-status':
				return 'Query status';
			case 'query-timeline':
				return 'Query timeline';
			case 'kill-worker':
				return workerOnline ? 'Kill the worker' : 'Restart the worker';
			case 'complete-delivery':
				return 'Complete delivery';
			case 'list-visibility':
				return 'List by visibility';
		}
		const exhaustive: never = control;
		return exhaustive;
	}
</script>

<section aria-label="Guided journey" class="journey">
	<header class="journey__header">
		<h2 class="journey__title">Guided journey</h2>
		<span
			class="journey__count"
			aria-label="Step {Math.min(activeStep + 1, TOUR.length)} of {TOUR.length}"
		>
			Step {Math.min(activeStep + 1, TOUR.length)} of {TOUR.length}
		</span>
	</header>

	<div class="journey__scroll">
		<!-- Active step detail + live region so changes are announced to screen readers -->
		<div role="status" aria-live="polite" aria-atomic="true">
			{#if isComplete}
				<div class="journey__card journey__card--complete">
					<h3 class="journey__card-title">Tour complete</h3>
					<p class="journey__copy">
						You started a durable workflow, changed it with a signal and a validated update, queried
						its state, searched Visibility, killed the worker, watched it replay and recover, and
						still delivered the order.
					</p>
				</div>
			{:else if currentStep !== undefined}
				<div class="journey__card">
					<p class="journey__eyebrow">{currentStep.concept}</p>
					<h3 class="journey__card-title">{currentStep.title}</h3>
					<p class="journey__copy">{currentStep.instruction}</p>
					<p class="journey__watch">
						<span class="journey__watch-label">Watch</span>
						<span>{currentStep.watch}</span>
					</p>
					{#if stepStuck}
						<!-- The workflow reached a terminal state first — this step's
						     completing event can never arrive. Offer a way out inline. -->
						<div class="journey__stuck">
							<p class="journey__stuck-copy">
								This step can't complete anymore — the workflow has already reached a final state.
							</p>
							<div class="journey__stuck-actions">
								<Button
									variant="soft"
									size="sm"
									label="Skip this step"
									onclick={() => onskip?.()}
								/>
								<Button
									variant="soft"
									size="sm"
									label="Restart tour"
									onclick={() => onrestart?.()}
								/>
							</div>
						</div>
					{:else if ctaControl === undefined}
						<p class="journey__watching">
							<Spinner size="sm" label="Watching the system respond" />
							Watching the system respond…
						</p>
					{:else if ctaEnabled}
						<Button
							variant="primary"
							fullWidth
							label={getActionLabel(ctaControl)}
							onclick={() => oncta?.(ctaControl)}
						/>
					{:else}
						<!-- The step has an action but it is gated right now. Show it
						     disabled with the reason so the tour is never a dead-end. -->
						<Button variant="primary" fullWidth disabled label={getActionLabel(ctaControl)} />
						<p class="journey__cta-blocked">
							{ctaBlockedReason ?? 'Waiting for the sandbox to be ready…'}
						</p>
					{/if}
					{#if currentStep.lookAt !== undefined}
						{@const lookAt = currentStep.lookAt}
						<div class="journey__lookat">
							<p class="journey__panel-label">Where to look</p>
							<div class="journey__panel-copy">
								<MarkdownText text={lookAt.note} />
							</div>
							<Button
								variant="soft"
								size="sm"
								label={lookAtButtonLabel(lookAt.surface)}
								onclick={() => onlookat?.(lookAt)}
							/>
						</div>
					{/if}
					{#if currentStep.experiment !== undefined}
						{@const experiment = currentStep.experiment}
						<div class="journey__experiment">
							<p class="journey__panel-label">Try changing the code</p>
							<div class="journey__panel-copy">
								<MarkdownText text={experiment.prompt} />
							</div>
							<Button
								variant="soft"
								size="sm"
								label="Show me the code"
								onclick={() => onshowcode?.(experiment)}
							/>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Step overview — accessible ordered list with aria-current on the active step -->
		<nav aria-label="Tour progress" class="journey__nav">
			<p class="journey__nav-label">All steps</p>
			<ol class="journey__steps">
				{#each TOUR as step, i (step.id)}
					{@const isDone = progress.completedStepIds.includes(step.id)}
					{@const isActive = i === activeStep && !isComplete}
					<!-- A step the tour advanced past without completing it (skipped
					     because its event could never fire) is neither done nor active. -->
					{@const isSkipped = i < activeStep && !isDone}
					<li
						class={[
							'journey__step',
							isDone && 'journey__step--done',
							isSkipped && 'journey__step--skipped',
							isActive && 'journey__step--active'
						]}
						aria-current={isActive ? 'step' : undefined}
					>
						<span class="journey__step-marker" aria-hidden="true">
							{#if isDone}✓{:else if isSkipped}–{:else}{i + 1}{/if}
						</span>
						<span class="journey__step-label">
							{step.title}{#if isSkipped}<span class="journey__step-note"> (skipped)</span>{/if}
						</span>
					</li>
				{/each}
			</ol>
		</nav>
	</div>
</section>

<style>
	.journey {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}

	.journey__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.625rem;
		flex: none;
		padding: 0.7rem 1.125rem;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.journey__title {
		margin: 0;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--cinder-accent-text);
	}

	.journey__count {
		font-size: 0.75rem;
		font-weight: 650;
		color: var(--cinder-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.journey__scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.125rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.journey__card {
		border: 1px solid var(--cinder-border);
		background: var(--cinder-surface-raised);
		border-radius: 0.75rem;
		padding: 0.9375rem;
		box-shadow: var(--cinder-shadow-sm);
	}

	.journey__card--complete {
		border-color: var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
	}

	.journey__card--complete .journey__card-title,
	.journey__card--complete .journey__copy {
		color: var(--cinder-color-success-fg);
	}

	.journey__eyebrow {
		margin: 0 0 0.3125rem;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--cinder-accent-text);
	}

	.journey__card-title {
		margin: 0 0 0.4375rem;
		font-size: 0.9375rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--cinder-text);
	}

	.journey__copy {
		margin: 0 0 0.6875rem;
		font-size: 0.78rem;
		line-height: 1.55;
		color: var(--cinder-text-muted);
	}

	.journey__watch {
		display: flex;
		gap: 0.4375rem;
		align-items: baseline;
		margin: 0 0 0.8125rem;
	}

	.journey__watch-label {
		flex: none;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.journey__watch > span:last-child {
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--cinder-text-muted);
	}

	.journey__cta-blocked {
		margin: 0.5rem 0 0;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--cinder-text-subtle);
	}

	.journey__stuck {
		padding: 0.5625rem 0.75rem;
		border-radius: 0.5625rem;
		border: 1px solid var(--cinder-color-warning-border, var(--cinder-border));
		background: var(--cinder-color-warning-bg, var(--cinder-surface-inset));
	}

	.journey__stuck-copy {
		margin: 0 0 0.5625rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--cinder-color-warning-fg, var(--cinder-text-muted));
	}

	.journey__stuck-actions {
		display: flex;
		gap: 0.5rem;
	}

	.journey__watching {
		display: flex;
		align-items: center;
		gap: 0.5625rem;
		margin: 0;
		padding: 0.5625rem 0.75rem;
		border-radius: 0.5625rem;
		background: color-mix(in oklch, var(--cinder-accent), transparent 90%);
		color: var(--cinder-accent-text);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.journey__experiment,
	.journey__lookat {
		margin-top: 0.8125rem;
		padding: 0.6875rem 0.75rem;
		border-radius: 0.5625rem;
	}

	.journey__experiment {
		border: 1px dashed var(--cinder-border);
		background: var(--cinder-surface-inset);
	}

	.journey__lookat {
		border: 1px solid color-mix(in oklch, var(--cinder-accent), transparent 72%);
		background: color-mix(in oklch, var(--cinder-accent), transparent 92%);
	}

	.journey__panel-label {
		margin: 0 0 0.3125rem;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.journey__lookat .journey__panel-label {
		color: var(--cinder-accent-text);
	}

	.journey__panel-copy {
		margin: 0 0 0.625rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--cinder-text-muted);
	}

	.journey__nav-label {
		margin: 0 0 0.375rem;
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.journey__steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.journey__step {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem;
		border-radius: 0.5rem;
		font-size: 0.78rem;
		color: var(--cinder-text-subtle);
	}

	.journey__step--done {
		color: var(--cinder-text-muted);
	}

	.journey__step--skipped {
		color: var(--cinder-text-subtle);
	}

	.journey__step-note {
		font-style: italic;
		color: var(--cinder-text-subtle);
	}

	.journey__step--active {
		background: color-mix(in oklch, var(--cinder-accent), transparent 90%);
		color: var(--cinder-text);
		font-weight: 650;
	}

	.journey__step-marker {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex: none;
		border-radius: 50%;
		font-size: 0.65rem;
		font-weight: 700;
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.journey__step--done .journey__step-marker {
		background: var(--cinder-success);
		color: #fff;
	}

	.journey__step--skipped .journey__step-marker {
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.journey__step--active .journey__step-marker {
		background: var(--cinder-accent);
		color: var(--cinder-accent-contrast);
	}
</style>
