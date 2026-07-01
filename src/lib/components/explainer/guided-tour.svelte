<script lang="ts">
	/**
	 * guided-tour.svelte — ordered, event-driven guided tour of Temporal features.
	 *
	 * Uses a plain accessible ordered list instead of the Cinder Steps component
	 * to avoid SVG/template initialization issues in vitest browser tests.
	 *
	 * Props:
	 *   progress — TourProgress snapshot; controls which step is active.
	 *   onreset  — callback invoked when the user clicks "Reset tour".
	 */
	import Button from '@lostgradient/cinder/button';
	import Badge from '@lostgradient/cinder/badge';
	import type { TourProgress } from '$lib/content/tour-engine';
	import { TOUR } from '$lib/content/demo-script';
	import type { ControlId } from '$lib/contracts/workflow-api';

	type Props = {
		/** Current progress snapshot; controls which step is active. */
		progress: TourProgress;
		/** Called when the user wants to reset tour progress. */
		onreset?: () => void;
	};

	let { progress, onreset }: Props = $props();

	const activeStep = $derived(progress.currentStepIndex);
	const isComplete = $derived(activeStep >= TOUR.length);
	const currentStep = $derived(TOUR[activeStep]);

	function handleReset() {
		onreset?.();
	}

	function getActionLabel(control: ControlId): string {
		switch (control) {
			case 'start-order':
				return 'Place Order';
			case 'cancel-order':
				return 'Cancel Order';
			case 'accept-restaurant':
				return 'Restaurant Accepted';
			case 'reject-restaurant':
				return 'Restaurant Rejected';
			case 'food-ready':
				return 'Food Ready';
			case 'update-location':
				return 'Update Courier Location';
			case 'add-tip':
				return 'Add Tip';
			case 'update-address':
				return 'Update Address';
			case 'apply-promo':
				return 'Apply Promo';
			case 'query-status':
				return 'Get Status';
			case 'query-timeline':
				return 'Get Timeline';
			case 'kill-worker':
				return 'Kill Worker, then Restart Worker';
			case 'complete-delivery':
				return 'Complete Delivery';
			case 'list-visibility':
				return 'List Visibility';
		}
		const exhaustive: never = control;
		return exhaustive;
	}
</script>

<section aria-label="Guided tour" class="guided-tour">
	<header class="guided-tour__header">
		<h2 class="guided-tour__title">Guided Tour</h2>
		<span
			class="guided-tour__count"
			aria-label="Step {Math.min(activeStep + 1, TOUR.length)} of {TOUR.length}"
		>
			Step {Math.min(activeStep + 1, TOUR.length)} of {TOUR.length}
		</span>
	</header>

	<!-- Active step detail + live region so changes are announced to screen readers -->
	<div role="status" aria-live="polite" aria-atomic="true" class="guided-tour__detail">
		{#if isComplete}
			<div class="guided-tour__complete">
				<p class="guided-tour__complete-message">
					Tour complete. You started a durable workflow, changed it with signals and updates,
					queried its state, searched it through Visibility, killed the worker, restarted it, and
					still delivered the order.
				</p>
			</div>
		{:else if currentStep !== undefined}
			<div class="guided-tour__step-detail">
				<h3 class="guided-tour__step-detail-title">{currentStep.title}</h3>
				<p class="guided-tour__step-instruction">{currentStep.instruction}</p>
				{#if currentStep.control}
					<p class="guided-tour__step-control">
						<span class="guided-tour__step-control-label">Next action:</span>
						<Badge variant="neutral">{getActionLabel(currentStep.control)}</Badge>
					</p>
				{/if}
			</div>
		{/if}
	</div>

	<details class="guided-tour__map">
		<summary>
			<span>Tour map</span>
			<span>{progress.completedStepIds.length} complete</span>
		</summary>
		<!-- Step overview — accessible ordered list with aria-current on the active step -->
		<nav aria-label="Tour progress" class="guided-tour__nav">
			<ol class="guided-tour__steps">
				{#each TOUR as step, i (step.id)}
					{@const isDone = i < activeStep}
					{@const isActive = i === activeStep}
					<li
						class="guided-tour__step"
						class:guided-tour__step--done={isDone}
						class:guided-tour__step--active={isActive}
						aria-current={isActive ? 'step' : undefined}
					>
						<span class="guided-tour__step-marker" aria-hidden="true">
							{#if isDone}✓{:else}{i + 1}{/if}
						</span>
						<span class="guided-tour__step-label">{step.title}</span>
						{#if step.control}
							<span class="guided-tour__step-hint">{getActionLabel(step.control)}</span>
						{/if}
					</li>
				{/each}
			</ol>
		</nav>
	</details>

	<footer class="guided-tour__footer">
		<Button variant="ghost" onclick={handleReset}>Reset tour</Button>
	</footer>
</section>

<style>
	.guided-tour {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.guided-tour__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.guided-tour__title {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0;
	}

	.guided-tour__count {
		font-size: 0.875rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.guided-tour__steps {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.guided-tour__map {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--color-surface-subtle, #f9fafb), transparent 12%);
	}

	.guided-tour__map > summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.65rem 0.75rem;
		cursor: pointer;
		list-style: none;
		color: var(--color-text-primary, #111827);
		font-weight: 700;
	}

	.guided-tour__map > summary::-webkit-details-marker {
		display: none;
	}

	.guided-tour__map > summary span:last-child {
		color: var(--color-text-muted, #9ca3af);
		font-size: 0.78rem;
		font-weight: 500;
	}

	.guided-tour__map > summary:focus-visible {
		outline: 2px solid #38bdf8;
		outline-offset: 2px;
	}

	.guided-tour__map .guided-tour__nav {
		padding: 0 0.75rem 0.75rem;
	}

	.guided-tour__step {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.875rem;
		padding: 0.25rem 0;
		color: var(--color-text-secondary, #6b7280);
	}

	.guided-tour__step--done {
		color: var(--color-success, #059669);
	}

	.guided-tour__step--active {
		color: var(--color-text-primary, #111827);
		font-weight: 600;
	}

	.guided-tour__step-marker {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		font-size: 0.75rem;
		background: var(--color-surface-subtle, #f3f4f6);
		border: 1px solid var(--color-border, #e5e7eb);
		flex-shrink: 0;
	}

	.guided-tour__step--done .guided-tour__step-marker {
		background: var(--color-success-light, #d1fae5);
		border-color: var(--color-success, #059669);
	}

	.guided-tour__step--active .guided-tour__step-marker {
		background: var(--color-accent, #3b82f6);
		border-color: var(--color-accent, #3b82f6);
		color: white;
	}

	.guided-tour__step-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted, #9ca3af);
		font-weight: 400;
	}

	.guided-tour__detail {
		padding: 0.75rem;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 0.5rem;
		background: var(--color-surface-subtle, #f9fafb);
		min-height: 5rem;
	}

	.guided-tour__step-detail-title {
		font-size: 1rem;
		font-weight: 600;
		margin-block-end: 0.5rem;
	}

	.guided-tour__step-instruction {
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--color-text-primary, #111827);
		margin-block-end: 0.5rem;
	}

	.guided-tour__step-control {
		font-size: 0.875rem;
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.guided-tour__step-control-label {
		color: var(--color-text-secondary, #6b7280);
	}

	.guided-tour__complete-message {
		margin: 0;
		font-weight: 700;
		line-height: 1.55;
		color: #bbf7d0;
	}

	.guided-tour__footer {
		display: flex;
		justify-content: flex-end;
	}
</style>
