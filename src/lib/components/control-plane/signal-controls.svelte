<script lang="ts">
	/**
	 * signal-controls.svelte — one button (and inline input) per Temporal signal.
	 *
	 * Signals: cancelOrder, restaurantAccepted, restaurantRejected, foodReady,
	 * courierLocationUpdate, addTip.
	 */
	import Button from '@lostgradient/cinder/button';
	import FormField from '@lostgradient/cinder/form-field';
	import Label from '@lostgradient/cinder/label';
	import NumberInput from '@lostgradient/cinder/number-input';
	import Textarea from '@lostgradient/cinder/textarea';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/form-field/styles';
	import '@lostgradient/cinder/label/styles';
	import '@lostgradient/cinder/number-input/styles';
	import '@lostgradient/cinder/textarea/styles';
	import type { TemporalController } from './types.ts';

	let {
		controller,
		workflowId
	}: {
		controller: TemporalController;
		workflowId: string;
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
</script>

<section aria-label="Signal controls">
	<!-- cancelOrder -->
	<div class="signal-group">
		<FormField id="cancel-reason" label="Cancellation reason" class="field">
			<Textarea id="cancel-reason" rows={2} bind:value={cancelReason} placeholder="Enter reason…" />
		</FormField>
		<Button
			label="Cancel Order"
			variant="danger"
			onclick={() =>
				send(() => controller.signal(workflowId, 'cancelOrder', { reason: cancelReason }))}
		/>
	</div>

	<!-- restaurantAccepted -->
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

	<!-- restaurantRejected -->
	<div class="signal-group">
		<FormField id="rejection-reason" label="Rejection reason" class="field">
			<Textarea
				id="rejection-reason"
				rows={2}
				bind:value={rejectionReason}
				placeholder="Enter reason…"
			/>
		</FormField>
		<div class="field checkbox-field">
			<input id="rejection-retryable" type="checkbox" bind:checked={rejectionRetryable} />
			<Label for="rejection-retryable">Retryable</Label>
		</div>
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

	<!-- foodReady -->
	<div class="signal-group">
		<Button
			label="Food Ready"
			variant="soft"
			onclick={() => send(() => controller.signal(workflowId, 'foodReady', {}))}
		/>
	</div>

	<!-- courierLocationUpdate -->
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

	<!-- addTip -->
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
</section>
