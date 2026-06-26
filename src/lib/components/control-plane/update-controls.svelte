<script lang="ts">
	/**
	 * update-controls.svelte — Temporal update controls with inline
	 * validator-rejection display.
	 *
	 * Updates: updateDeliveryAddress, applyPromoCode.
	 *
	 * When the Temporal validator rejects an update, the rejection reason is
	 * shown inline immediately below the relevant form — it is never surfaced
	 * as an unhandled error.
	 */
	import Button from '@lostgradient/cinder/button';
	import type { TemporalController } from './types.ts';
	import { isUpdateRejectionError } from './types.ts';
	import type {
		UpdateDeliveryAddressResult,
		ApplyPromoCodeResult
	} from '$lib/contracts/workflow-api';

	let {
		controller,
		workflowId
	}: {
		controller: TemporalController;
		workflowId: string;
	} = $props();

	// --- updateDeliveryAddress state ------------------------------------------

	let newStreet = $state('');
	let newCity = $state('');
	let newAddressState = $state('');
	let newPostalCode = $state('');
	let addressSubmitting = $state(false);
	let addressError = $state<string | null>(null);
	let addressResult = $state<UpdateDeliveryAddressResult | null>(null);

	async function updateAddress(): Promise<void> {
		addressError = null;
		addressResult = null;
		addressSubmitting = true;
		try {
			const result = await controller.update(workflowId, 'updateDeliveryAddress', {
				newAddress: {
					street: newStreet,
					city: newCity,
					state: newAddressState,
					postalCode: newPostalCode
				}
			});
			addressResult = result;
		} catch (err) {
			if (isUpdateRejectionError(err)) {
				addressError = err.reason;
			} else {
				addressError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			addressSubmitting = false;
		}
	}

	// --- applyPromoCode state -------------------------------------------------

	let promoCode = $state('');
	let promoSubmitting = $state(false);
	let promoError = $state<string | null>(null);
	let promoResult = $state<ApplyPromoCodeResult | null>(null);

	async function applyPromo(): Promise<void> {
		promoError = null;
		promoResult = null;
		promoSubmitting = true;
		try {
			const result = await controller.update(workflowId, 'applyPromoCode', {
				code: promoCode
			});
			promoResult = result;
		} catch (err) {
			if (isUpdateRejectionError(err)) {
				promoError = err.reason;
			} else {
				promoError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			promoSubmitting = false;
		}
	}
</script>

<section aria-label="Update controls">
	<!-- updateDeliveryAddress -->
	<div class="update-group">
		<h3>Update delivery address</h3>

		<div class="field">
			<label for="new-street">New street</label>
			<input id="new-street" type="text" bind:value={newStreet} autocomplete="off" />
		</div>
		<div class="field">
			<label for="new-city">New city</label>
			<input id="new-city" type="text" bind:value={newCity} autocomplete="off" />
		</div>
		<div class="field">
			<label for="new-state">New state</label>
			<input id="new-state" type="text" bind:value={newAddressState} autocomplete="off" />
		</div>
		<div class="field">
			<label for="new-postal-code">New postal code</label>
			<input id="new-postal-code" type="text" bind:value={newPostalCode} autocomplete="off" />
		</div>

		{#if addressError}
			<p role="alert" class="inline-error" aria-live="polite">{addressError}</p>
		{/if}

		{#if addressResult}
			<p role="status" class="inline-success">
				Address updated: {addressResult.effectiveAddress.street}
			</p>
		{/if}

		<Button
			label="Update Address"
			variant="secondary"
			loading={addressSubmitting}
			onclick={updateAddress}
		/>
	</div>

	<!-- applyPromoCode -->
	<div class="update-group">
		<h3>Apply promo code</h3>

		<div class="field">
			<label for="promo-code">Promo code</label>
			<input
				id="promo-code"
				type="text"
				bind:value={promoCode}
				autocomplete="off"
				placeholder="e.g. SAVE10"
			/>
		</div>

		{#if promoError}
			<p role="alert" class="inline-error" aria-live="polite">{promoError}</p>
		{/if}

		{#if promoResult}
			<p role="status" class="inline-success">
				{promoResult.description}
				(−{promoResult.discountCents}¢)
			</p>
		{/if}

		<Button
			label="Apply Promo"
			variant="secondary"
			loading={promoSubmitting}
			onclick={applyPromo}
		/>
	</div>
</section>
