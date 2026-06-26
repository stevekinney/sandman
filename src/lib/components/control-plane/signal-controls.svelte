<script lang="ts">
	/**
	 * signal-controls.svelte — one button (and inline input) per Temporal signal.
	 *
	 * Signals: cancelOrder, restaurantAccepted, restaurantRejected, foodReady,
	 * courierLocationUpdate, addTip.
	 */
	import Button from '@lostgradient/cinder/button';
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
	let estimatedPrepMinutes = $state(20);
	let rejectionReason = $state('');
	let rejectionRetryable = $state(false);
	let courierLat = $state(0);
	let courierLng = $state(0);
	let tipAmountCents = $state(0);

	// --- sending helpers -------------------------------------------------------

	async function send<T>(fn: () => Promise<T>): Promise<void> {
		await fn();
	}
</script>

<section aria-label="Signal controls">
	<!-- cancelOrder -->
	<div class="signal-group">
		<div class="field">
			<label for="cancel-reason">Cancellation reason</label>
			<input id="cancel-reason" type="text" bind:value={cancelReason} placeholder="Enter reason…" />
		</div>
		<Button
			label="Cancel Order"
			variant="danger"
			onclick={() =>
				send(() => controller.signal(workflowId, 'cancelOrder', { reason: cancelReason }))}
		/>
	</div>

	<!-- restaurantAccepted -->
	<div class="signal-group">
		<div class="field">
			<label for="prep-minutes">Estimated prep (minutes)</label>
			<input id="prep-minutes" type="number" min="1" bind:value={estimatedPrepMinutes} />
		</div>
		<Button
			label="Restaurant Accepted"
			variant="soft"
			onclick={() =>
				send(() =>
					controller.signal(workflowId, 'restaurantAccepted', {
						estimatedPrepMinutes
					})
				)}
		/>
	</div>

	<!-- restaurantRejected -->
	<div class="signal-group">
		<div class="field">
			<label for="rejection-reason">Rejection reason</label>
			<input
				id="rejection-reason"
				type="text"
				bind:value={rejectionReason}
				placeholder="Enter reason…"
			/>
		</div>
		<div class="field">
			<label>
				<input type="checkbox" bind:checked={rejectionRetryable} />
				Retryable
			</label>
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
		<div class="field">
			<label for="courier-lat">Courier latitude</label>
			<input id="courier-lat" type="number" step="any" bind:value={courierLat} />
		</div>
		<div class="field">
			<label for="courier-lng">Courier longitude</label>
			<input id="courier-lng" type="number" step="any" bind:value={courierLng} />
		</div>
		<Button
			label="Update Courier Location"
			variant="soft"
			onclick={() =>
				send(() =>
					controller.signal(workflowId, 'courierLocationUpdate', {
						lat: courierLat,
						lng: courierLng
					})
				)}
		/>
	</div>

	<!-- addTip -->
	<div class="signal-group">
		<div class="field">
			<label for="tip-amount">Tip amount (cents)</label>
			<input id="tip-amount" type="number" min="1" bind:value={tipAmountCents} />
		</div>
		<Button
			label="Add Tip"
			variant="soft"
			onclick={() =>
				send(() => controller.signal(workflowId, 'addTip', { amountCents: tipAmountCents }))}
		/>
	</div>
</section>
