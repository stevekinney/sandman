<script lang="ts">
	/**
	 * signal-controls.svelte — one button (and inline input) per Temporal signal.
	 *
	 * Signals: cancelOrder, restaurantAccepted, restaurantRejected, foodReady,
	 * courierLocationUpdate, addTip.
	 */
	import Button from '@lostgradient/cinder/button';
	import Checkbox from '@lostgradient/cinder/checkbox';
	import FormField from '@lostgradient/cinder/form-field';
	import NumberInput from '@lostgradient/cinder/number-input';
	import Textarea from '@lostgradient/cinder/textarea';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/checkbox/styles';
	import '@lostgradient/cinder/form-field/styles';
	import '@lostgradient/cinder/number-input/styles';
	import '@lostgradient/cinder/textarea/styles';
	import type { TemporalController } from './types.ts';
	import type { ControlId } from '$lib/contracts/workflow-api';

	let {
		controller,
		workflowId,
		deliveryWorkflowId,
		recommendedControl
	}: {
		controller: TemporalController;
		workflowId: string;
		deliveryWorkflowId?: string;
		recommendedControl?: ControlId;
	} = $props();

	// --- per-signal state -----------------------------------------------------

	let cancelReason = $state('');
	let estimatedPrepMinutes = $state<number | null>(20);
	let rejectionReason = $state('');
	let rejectionRetryable = $state(false);
	let courierLat = $state<number | null>(0);
	let courierLng = $state<number | null>(0);
	let tipAmountCents = $state<number | null>(0);

	// --- sending helpers -------------------------------------------------------

	async function send<T>(fn: () => Promise<T>): Promise<void> {
		await fn();
	}

	function shouldShow(control: ControlId): boolean {
		if (recommendedControl === undefined) return true;
		return recommendedControl === control;
	}
</script>

<section aria-label="Signal controls">
	<!-- cancelOrder -->
	{#if shouldShow('cancel-order')}
		<div class="signal-group">
			<FormField id="cancel-reason" label="Cancellation reason" class="field">
				<Textarea
					id="cancel-reason"
					rows={2}
					bind:value={cancelReason}
					placeholder="Enter reason…"
				/>
			</FormField>
			<Button
				label="Cancel Order"
				variant="danger"
				onclick={() =>
					send(() => controller.signal(workflowId, 'cancelOrder', { reason: cancelReason }))}
			/>
		</div>
	{/if}

	<!-- restaurantAccepted -->
	{#if shouldShow('accept-restaurant')}
		<div class="signal-group">
			<FormField id="prep-minutes" label="Estimated prep (minutes)" class="field">
				<NumberInput id="prep-minutes" min={1} bind:value={estimatedPrepMinutes} />
			</FormField>
			<Button
				label="Restaurant Accepted"
				variant="soft"
				onclick={() =>
					send(() =>
						controller.signal(workflowId, 'restaurantAccepted', {
							estimatedPrepMinutes: estimatedPrepMinutes ?? 0
						})
					)}
			/>
		</div>
	{/if}

	<!-- restaurantRejected -->
	{#if shouldShow('reject-restaurant')}
		<div class="signal-group">
			<FormField id="rejection-reason" label="Rejection reason" class="field">
				<Textarea
					id="rejection-reason"
					rows={2}
					bind:value={rejectionReason}
					placeholder="Enter reason…"
				/>
			</FormField>
			<Checkbox
				id="rejection-retryable"
				class="field"
				label="Retryable"
				bind:checked={rejectionRetryable}
			/>
			<Button
				label="Restaurant Rejected"
				variant="soft-danger"
				onclick={() =>
					send(() =>
						controller.signal(workflowId, 'restaurantRejected', {
							reason: rejectionReason,
							retryable: rejectionRetryable
						})
					)}
			/>
		</div>
	{/if}

	<!-- foodReady -->
	{#if shouldShow('food-ready')}
		<div class="signal-group">
			<Button
				label="Food Ready"
				variant="soft"
				onclick={() => send(() => controller.signal(workflowId, 'foodReady', {}))}
			/>
		</div>
	{/if}

	<!-- courierLocationUpdate -->
	{#if shouldShow('update-location')}
		<div class="signal-group">
			<FormField id="courier-lat" label="Courier latitude" class="field">
				<NumberInput id="courier-lat" step={0.0001} bind:value={courierLat} />
			</FormField>
			<FormField id="courier-lng" label="Courier longitude" class="field">
				<NumberInput id="courier-lng" step={0.0001} bind:value={courierLng} />
			</FormField>
			<Button
				label="Update Courier Location"
				variant="soft"
				onclick={() =>
					send(() =>
						controller.signal(workflowId, 'courierLocationUpdate', {
							lat: courierLat ?? 0,
							lng: courierLng ?? 0
						})
					)}
			/>
		</div>
	{/if}

	<!-- addTip -->
	{#if shouldShow('add-tip')}
		<div class="signal-group">
			<FormField id="tip-amount" label="Tip amount (cents)" class="field">
				<NumberInput id="tip-amount" min={1} bind:value={tipAmountCents} />
			</FormField>
			<Button
				label="Add Tip"
				variant="soft"
				onclick={() =>
					send(() => controller.signal(workflowId, 'addTip', { amountCents: tipAmountCents ?? 0 }))}
			/>
		</div>
	{/if}

	{#if deliveryWorkflowId !== undefined && shouldShow('complete-delivery')}
		<div class="signal-group">
			<Button
				label="Complete Delivery"
				variant="primary"
				onclick={() => send(() => controller.signal(deliveryWorkflowId, 'deliveryCompleted', {}))}
			/>
		</div>
	{/if}
</section>
