<script lang="ts">
	/**
	 * start-order-form.svelte — collects the minimum required fields
	 * to build an `OrderInput` and calls `controller.start()`.
	 *
	 * Emits `onstarted` with the returned `WorkflowRun` so the parent
	 * can transition to the post-start control panel.
	 */
	import Button from '@lostgradient/cinder/button';
	import FormField from '@lostgradient/cinder/form-field';
	import Input from '@lostgradient/cinder/input';
	import NumberInput from '@lostgradient/cinder/number-input';
	import Select from '@lostgradient/cinder/select';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/form-field/styles';
	import '@lostgradient/cinder/input/styles';
	import '@lostgradient/cinder/number-input/styles';
	import '@lostgradient/cinder/select/styles';
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
	const customerTierOptions = Object.values(CUSTOMER_TIER).map((tier) => ({
		value: tier,
		label: tier
	}));

	// Single item for the demo
	let itemName = $state('');
	let itemPriceCents = $state<number | null>(0);

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
					unitPriceCents: itemPriceCents ?? 0
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

		<FormField id="restaurant-id" label="Restaurant ID" required class="field">
			<Input id="restaurant-id" type="text" bind:value={restaurantId} autocomplete="off" />
		</FormField>

		<FormField id="customer-id" label="Customer ID" required class="field">
			<Input id="customer-id" type="text" bind:value={customerId} autocomplete="off" />
		</FormField>

		<FormField id="customer-tier" label="Customer tier" class="field">
			<Select id="customer-tier" bind:value={customerTier} options={customerTierOptions} />
		</FormField>
	</fieldset>

	<fieldset>
		<legend>Item</legend>

		<FormField id="item-name" label="Item name" required class="field">
			<Input id="item-name" type="text" bind:value={itemName} autocomplete="off" />
		</FormField>

		<FormField id="item-price" label="Item price (cents)" required class="field">
			<NumberInput id="item-price" min={1} bind:value={itemPriceCents} />
		</FormField>
	</fieldset>

	<fieldset>
		<legend>Delivery address</legend>

		<FormField id="street" label="Street" required class="field">
			<Input id="street" type="text" bind:value={street} autocomplete="street-address" />
		</FormField>

		<FormField id="city" label="City" required class="field">
			<Input id="city" type="text" bind:value={city} autocomplete="address-level2" />
		</FormField>

		<FormField id="addr-state" label="State" required class="field">
			<Input id="addr-state" type="text" bind:value={addressState} autocomplete="address-level1" />
		</FormField>

		<FormField id="postal-code" label="Postal code" required class="field">
			<Input id="postal-code" type="text" bind:value={postalCode} autocomplete="postal-code" />
		</FormField>
	</fieldset>

	{#if error}
		<p role="alert" class="error">{error}</p>
	{/if}

	<Button type="submit" label="Start Order" loading={submitting} />
</form>
