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
	import FormField from '@lostgradient/cinder/form-field';
	import Input from '@lostgradient/cinder/input';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/form-field/styles';
	import '@lostgradient/cinder/input/styles';
	import type { TemporalController } from './types.ts';
	import { isUpdateRejectionError } from './types.ts';
	import type {
		ControlId,
		UpdateDeliveryAddressResult,
		ApplyPromoCodeResult
	} from '$lib/contracts/workflow-api';

	let {
		controller,
		workflowId,
		recommendedControl
	}: {
		controller: TemporalController;
		workflowId: string;
		recommendedControl?: ControlId;
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

	function shouldShow(control: ControlId): boolean {
		if (recommendedControl === undefined) return true;
		return recommendedControl === control;
	}
</script>

<section aria-label="Update controls">
	<!-- updateDeliveryAddress -->
	{#if shouldShow('update-address')}
		<div class="update-group">
			<h3>Update delivery address</h3>

			<FormField id="new-street" label="New street" class="field">
				<Input id="new-street" type="text" bind:value={newStreet} autocomplete="off" />
			</FormField>
			<FormField id="new-city" label="New city" class="field">
				<Input id="new-city" type="text" bind:value={newCity} autocomplete="off" />
			</FormField>
			<FormField id="new-state" label="New state" class="field">
				<Input id="new-state" type="text" bind:value={newAddressState} autocomplete="off" />
			</FormField>
			<FormField id="new-postal-code" label="New postal code" class="field">
				<Input id="new-postal-code" type="text" bind:value={newPostalCode} autocomplete="off" />
			</FormField>

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
	{/if}

	<!-- applyPromoCode -->
	{#if shouldShow('apply-promo')}
		<div class="update-group">
			<h3>Apply promo code</h3>

			<FormField id="promo-code" label="Promo code" class="field">
				<Input
					id="promo-code"
					type="text"
					bind:value={promoCode}
					autocomplete="off"
					placeholder="e.g. SAVE10"
				/>
			</FormField>

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
	{/if}
</section>
