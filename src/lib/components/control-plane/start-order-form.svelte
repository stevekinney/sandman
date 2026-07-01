<script lang="ts">
	/**
	 * start-order-form.svelte — presents a realistic prefilled food order and
	 * calls `controller.start()`.
	 *
	 * Emits `onstarted` with the returned `WorkflowRun` so the parent
	 * can transition to the post-start control panel.
	 */
	import Badge from '@lostgradient/cinder/badge';
	import Button from '@lostgradient/cinder/button';
	import '@lostgradient/cinder/badge/styles';
	import '@lostgradient/cinder/button/styles';
	import type { TemporalController, WorkflowRun } from './types.ts';
	import type { OrderInput } from '$lib/contracts/workflow-api';
	import { CUSTOMER_TIER } from '$lib/contracts/workflow-api';

	let {
		controller,
		onstarted
	}: {
		controller: TemporalController;
		onstarted: (run: WorkflowRun, order: OrderInput) => void;
	} = $props();

	type MenuItem = {
		id: string;
		name: string;
		description: string;
		priceCents: number;
		popular?: boolean;
	};

	const restaurant = {
		restaurantName: 'Kitsune Kitchen',
		restaurantId: 'kitchen-44',
		customerId: 'customer-2187',
		deliveryAddress: {
			street: '221 Market Street',
			city: 'Denver',
			state: 'CO',
			postalCode: '80205',
			notes: 'Leave at the front desk'
		},
		eta: '25-35 min',
		deliveryFeeCents: 299
	};

	const menuItems: MenuItem[] = [
		{
			id: 'spicy-noodles',
			name: 'Spicy noodles',
			description: 'Chili crisp, sesame greens, soft egg',
			priceCents: 1295,
			popular: true
		},
		{
			id: 'miso-caesar',
			name: 'Miso caesar salad',
			description: 'Little gems, furikake crunch, yuzu dressing',
			priceCents: 1095
		},
		{
			id: 'ginger-lime-soda',
			name: 'Ginger lime soda',
			description: 'House ginger syrup, lime, sparkling water',
			priceCents: 425
		}
	];

	let submitting = $state(false);
	let error = $state<StartOrderError | null>(null);
	let selectedQuantities = $state<Record<string, number>>({
		'spicy-noodles': 1
	});

	const cartItems = $derived(
		menuItems
			.map((item) => ({
				...item,
				quantity: selectedQuantities[item.id] ?? 0
			}))
			.filter((item) => item.quantity > 0)
	);
	const subtotalCents = $derived(
		cartItems.reduce((sum, item) => sum + item.quantity * item.priceCents, 0)
	);
	const totalCents = $derived(subtotalCents + restaurant.deliveryFeeCents);
	const canSubmit = $derived(cartItems.length > 0 && !submitting);

	function formatMoney(cents: number): string {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
			cents / 100
		);
	}

	function updateQuantity(itemId: string, delta: number): void {
		const nextQuantity = Math.max(0, (selectedQuantities[itemId] ?? 0) + delta);
		selectedQuantities = { ...selectedQuantities, [itemId]: nextQuantity };
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!canSubmit) return;

		submitting = true;
		error = null;

		const input: OrderInput = {
			orderId: crypto.randomUUID(),
			restaurantId: restaurant.restaurantId,
			customerId: restaurant.customerId,
			customerTier: CUSTOMER_TIER.Standard,
			items: cartItems.map((item) => ({
				itemId: item.id,
				name: item.name,
				quantity: item.quantity,
				unitPriceCents: item.priceCents
			})),
			deliveryAddress: restaurant.deliveryAddress,
			visibilitySearchAttributesEnabled: true,
			paymentMethod: {
				type: 'card',
				last4: '4242',
				brand: 'Visa'
			}
		};

		try {
			const run = await controller.start(input);
			onstarted(run, input);
		} catch (err) {
			error = formatStartOrderError(err);
		} finally {
			submitting = false;
		}
	}

	type StartOrderError = {
		title: string;
		message: string;
		action: string;
		detail: string | null;
	};

	function formatStartOrderError(value: unknown): StartOrderError {
		const rawMessage = value instanceof Error ? value.message : String(value);
		const detail = normalizeStartOrderErrorDetail(rawMessage);

		return {
			title: 'The order workflow did not start',
			message:
				'Sandman reached the sandbox, but Temporal did not accept the workflow start command.',
			action:
				'Try Place Order again. If it repeats, start a new session so the Temporal worker and command state are clean.',
			detail
		};
	}

	function normalizeStartOrderErrorDetail(message: string): string | null {
		const withoutPrefix = message.replace(/^Failed to start workflow:\s*/i, '').trim();
		if (withoutPrefix.length === 0) return null;

		const parsed = parseJsonObject(withoutPrefix);
		if (parsed !== null) {
			const parsedMessage =
				getStringProperty(parsed, 'message') ?? getStringProperty(parsed, 'error');
			if (parsedMessage !== null && parsedMessage.trim().length > 0) return parsedMessage;
		}

		return withoutPrefix;
	}

	function parseJsonObject(value: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			return null;
		}
		return null;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function getStringProperty(value: Record<string, unknown>, key: string): string | null {
		const property = value[key];
		return typeof property === 'string' ? property : null;
	}
</script>

<form onsubmit={handleSubmit} aria-label="Start a new order" class="order-start">
	<section class="restaurant-header" aria-labelledby="restaurant-title">
		<div class="restaurant-row">
			<div>
				<p class="eyebrow">Order from</p>
				<h2 id="restaurant-title">{restaurant.restaurantName}</h2>
				<p class="restaurant-meta">Japanese comfort food · 4.8 stars · $2.99 delivery</p>
			</div>
			<Badge variant="info">{restaurant.eta}</Badge>
		</div>
	</section>

	{#if error}
		<div role="alert" class="error-card">
			<p class="error-title">{error.title}</p>
			<p class="error-message">{error.message}</p>
			<p class="error-action">{error.action}</p>
			{#if error.detail}
				<details class="error-detail">
					<summary>Technical detail</summary>
					<code>{error.detail}</code>
				</details>
			{/if}
		</div>
	{/if}

	<Button type="submit" label="Place Order" loading={submitting} disabled={!canSubmit} fullWidth />

	<section class="menu-section" aria-labelledby="menu-title">
		<h3 id="menu-title">Popular items</h3>
		<ul class="menu-list">
			{#each menuItems as item (item.id)}
				<li class="menu-item">
					<div class="item-copy">
						<div class="item-title-row">
							<p class="item-name">{item.name}</p>
							{#if item.popular}
								<Badge variant="success" size="xs">Popular</Badge>
							{/if}
						</div>
						<p class="item-description">{item.description}</p>
						<p class="price">{formatMoney(item.priceCents)}</p>
					</div>
					<div class="quantity-control" aria-label={`${item.name} quantity`}>
						<Button
							type="button"
							variant="secondary"
							size="xs"
							iconOnly
							label={`Remove ${item.name}`}
							disabled={(selectedQuantities[item.id] ?? 0) === 0}
							onclick={() => updateQuantity(item.id, -1)}
						>
							-
						</Button>
						<span aria-live="polite">{selectedQuantities[item.id] ?? 0}</span>
						<Button
							type="button"
							variant="secondary"
							size="xs"
							iconOnly
							label={`Add ${item.name}`}
							onclick={() => updateQuantity(item.id, 1)}
						>
							+
						</Button>
					</div>
				</li>
			{/each}
		</ul>
	</section>

	<section class="checkout-section" aria-labelledby="cart-title">
		<h3 id="cart-title">Cart</h3>
		{#if cartItems.length > 0}
			<ul class="cart-list">
				{#each cartItems as item (item.id)}
					<li>
						<span>{item.quantity}x {item.name}</span>
						<span>{formatMoney(item.quantity * item.priceCents)}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty-cart">Add an item to start the order.</p>
		{/if}
		<div class="summary-grid">
			<div>
				<p class="eyebrow">Delivery</p>
				<p>{restaurant.deliveryAddress.street}, {restaurant.deliveryAddress.city}</p>
				<p class="muted">{restaurant.deliveryAddress.notes}</p>
			</div>
			<div>
				<p class="eyebrow">Payment</p>
				<p>Visa ending in 4242</p>
				<p class="muted">Standard customer</p>
			</div>
		</div>
		<div class="totals">
			<div>
				<span>Subtotal</span>
				<span>{formatMoney(subtotalCents)}</span>
			</div>
			<div>
				<span>Delivery</span>
				<span>{formatMoney(restaurant.deliveryFeeCents)}</span>
			</div>
			<div class="total-row">
				<span>Total</span>
				<span>{formatMoney(totalCents)}</span>
			</div>
		</div>
	</section>
</form>

<style>
	.order-start {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		min-width: 0;
	}

	.restaurant-header,
	.menu-section,
	.checkout-section {
		min-width: 0;
		padding: 1rem;
		border: 1px solid var(--cinder-border, #334155);
		border-radius: 0.5rem;
		background: var(--cinder-surface, #0f172a);
	}

	.restaurant-header h2,
	.menu-section h3,
	.checkout-section h3 {
		margin: 0;
		line-height: 1.25;
		color: var(--cinder-text, #e2e8f0);
	}

	.restaurant-header h2 {
		font-size: 1.15rem;
	}

	.menu-section h3,
	.checkout-section h3 {
		font-size: 0.95rem;
	}

	.restaurant-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.item-name,
	.price {
		margin: 0;
		font-weight: 700;
		color: var(--cinder-text, #e2e8f0);
	}

	.restaurant-meta {
		margin: 0.3rem 0 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.item-description,
	.muted,
	.empty-cart {
		margin: 0.2rem 0 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.eyebrow {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.menu-list,
	.cart-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 0.85rem 0 0;
		padding: 0;
		list-style: none;
	}

	.menu-item {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--cinder-border, #334155);
	}

	.menu-item:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}

	.item-copy {
		flex: 1 1 16rem;
		min-width: min(100%, 16rem);
	}

	.item-title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.quantity-control {
		display: grid;
		grid-template-columns: 1.75rem 1.5rem 1.75rem;
		align-items: center;
		justify-items: center;
		margin-left: auto;
	}

	.quantity-control span {
		color: var(--cinder-text, #e2e8f0);
		font-weight: 700;
	}

	.cart-list li,
	.totals div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		color: var(--cinder-text, #e2e8f0);
	}

	.error-card {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		border: 1px solid #f97316;
		border-radius: 0.5rem;
		background: #2a1407;
		color: #fed7aa;
		padding: 0.8rem 0.9rem;
	}

	.error-title,
	.error-message,
	.error-action {
		margin: 0;
	}

	.error-title {
		font-weight: 800;
		color: #ffedd5;
	}

	.error-message,
	.error-action {
		line-height: 1.45;
	}

	.error-detail {
		margin-top: 0.15rem;
	}

	.error-detail summary {
		cursor: pointer;
		font-weight: 700;
		color: #fdba74;
	}

	.error-detail summary:focus-visible {
		outline: 2px solid #fed7aa;
		outline-offset: 2px;
	}

	.error-detail code {
		display: block;
		margin-top: 0.4rem;
		overflow-wrap: anywhere;
		color: #ffedd5;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.8rem;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--cinder-border, #334155);
	}

	.summary-grid p {
		margin: 0;
	}

	.totals {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--cinder-border, #334155);
	}

	.total-row {
		font-weight: 800;
	}

	@media (min-width: 38rem) {
		.order-start {
			display: flex;
			flex-direction: column;
		}
	}
</style>
