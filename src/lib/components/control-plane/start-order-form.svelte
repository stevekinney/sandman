<script lang="ts">
	/**
	 * start-order-form.svelte — collects the minimum required fields
	 * to build an `OrderInput` and calls `controller.start()`.
	 *
	 * Emits `onstarted` with the returned `WorkflowRun` so the parent
	 * can transition to the post-start control panel.
	 */
	import Button from '@lostgradient/cinder/button';
	import type { TemporalController, WorkflowRun } from './types.ts';
	import type { OrderInput, CustomerTier } from '$lib/contracts/workflow-api';
	import { CUSTOMER_TIER } from '$lib/contracts/workflow-api';

	let {
		controller,
		onstarted
	}: {
		controller: TemporalController;
		onstarted: (run: WorkflowRun) => void;
	} = $props();

	// --- form state -----------------------------------------------------------

	let restaurantId = $state('');
	let customerId = $state('');
	let customerTier = $state<CustomerTier>(CUSTOMER_TIER.Standard);

	// Single item for the demo
	let itemName = $state('');
	let itemPriceCents = $state(0);

	// Delivery address
	let street = $state('');
	let city = $state('');
	let addressState = $state('');
	let postalCode = $state('');

	let submitting = $state(false);
	let error = $state<string | null>(null);

	// --- submit ---------------------------------------------------------------

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		submitting = true;
		error = null;

		const input: OrderInput = {
			orderId: crypto.randomUUID(),
			restaurantId,
			customerId,
			customerTier,
			items: [
				{
					itemId: crypto.randomUUID(),
					name: itemName,
					quantity: 1,
					unitPriceCents: itemPriceCents
				}
			],
			deliveryAddress: {
				street,
				city,
				state: addressState,
				postalCode
			},
			paymentMethod: {
				type: 'card',
				last4: '4242',
				brand: 'Visa'
			}
		};

		try {
			const run = await controller.start(input);
			onstarted(run);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<form onsubmit={handleSubmit} aria-label="Start a new order">
	<fieldset>
		<legend>Order details</legend>

		<div class="field">
			<label for="restaurant-id">Restaurant ID</label>
			<input id="restaurant-id" type="text" bind:value={restaurantId} required autocomplete="off" />
		</div>

		<div class="field">
			<label for="customer-id">Customer ID</label>
			<input id="customer-id" type="text" bind:value={customerId} required autocomplete="off" />
		</div>

		<div class="field">
			<label for="customer-tier">Customer tier</label>
			<select id="customer-tier" bind:value={customerTier}>
				{#each Object.values(CUSTOMER_TIER) as tier (tier)}
					<option value={tier}>{tier}</option>
				{/each}
			</select>
		</div>
	</fieldset>

	<fieldset>
		<legend>Item</legend>

		<div class="field">
			<label for="item-name">Item name</label>
			<input id="item-name" type="text" bind:value={itemName} required autocomplete="off" />
		</div>

		<div class="field">
			<label for="item-price">Item price (cents)</label>
			<input id="item-price" type="number" min="1" bind:value={itemPriceCents} required />
		</div>
	</fieldset>

	<fieldset>
		<legend>Delivery address</legend>

		<div class="field">
			<label for="street">Street</label>
			<input id="street" type="text" bind:value={street} required autocomplete="street-address" />
		</div>

		<div class="field">
			<label for="city">City</label>
			<input id="city" type="text" bind:value={city} required autocomplete="address-level2" />
		</div>

		<div class="field">
			<label for="addr-state">State</label>
			<input
				id="addr-state"
				type="text"
				bind:value={addressState}
				required
				autocomplete="address-level1"
			/>
		</div>

		<div class="field">
			<label for="postal-code">Postal code</label>
			<input
				id="postal-code"
				type="text"
				bind:value={postalCode}
				required
				autocomplete="postal-code"
			/>
		</div>
	</fieldset>

	{#if error}
		<p role="alert" class="error">{error}</p>
	{/if}

	<Button type="submit" label="Start Order" loading={submitting} />
</form>
