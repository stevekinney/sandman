/**
 * session-actions.test.ts — unit tests for the pure workbench logic:
 * phase derivation, control gating, demo payloads, and chip mappings.
 */
import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '$lib/contracts/workflow-api';
import { ORDER_STATUS } from '$lib/contracts/workflow-api';
import orderWorkflowSource from '../../../../sandbox-template/order-workflow.ts?raw';
import {
	DEMO_UPDATED_ADDRESS,
	buildDemoOrder,
	canUseControl,
	deliveryWorkflowIdFor,
	derivePhase,
	executionPointerFor,
	formatMoney,
	isRunActive,
	orderStageDot,
	orderStageLabel,
	sandboxDot,
	workflowDot,
	workflowTag,
	type ControlContext,
	type SessionPhase
} from './session-actions.ts';

function entry(status: TimelineEntry['status'], index: number): TimelineEntry {
	return { index, timestamp: new Date(index * 1000).toISOString(), description: 'entry', status };
}

function describedEntry(
	status: TimelineEntry['status'],
	index: number,
	description: string
): TimelineEntry {
	return { index, timestamp: new Date(index * 1000).toISOString(), description, status };
}

function context(overrides: Partial<ControlContext> = {}): ControlContext {
	return {
		phase: 'idle',
		sandboxUsable: true,
		serverOnline: true,
		workerOnline: true,
		...overrides
	};
}

describe('derivePhase', () => {
	it('is idle before a run starts', () => {
		expect(derivePhase(false, [])).toBe('idle');
	});

	it('reads as Created once started but before the first timeline entry', () => {
		expect(derivePhase(true, [])).toBe(ORDER_STATUS.Created);
	});

	it('tracks the latest timeline entry status', () => {
		const entries = [entry(ORDER_STATUS.Created, 0), entry(ORDER_STATUS.Preparing, 1)];
		expect(derivePhase(true, entries)).toBe(ORDER_STATUS.Preparing);
	});
});

describe('isRunActive', () => {
	it('is false for idle and terminal phases', () => {
		for (const phase of [
			'idle',
			ORDER_STATUS.Delivered,
			ORDER_STATUS.Cancelled,
			ORDER_STATUS.Refunded
		] as SessionPhase[]) {
			expect(isRunActive(phase)).toBe(false);
		}
	});

	it('is true while the order progresses', () => {
		for (const phase of [
			ORDER_STATUS.Created,
			ORDER_STATUS.AwaitingRestaurant,
			ORDER_STATUS.InDelivery
		] as SessionPhase[]) {
			expect(isRunActive(phase)).toBe(true);
		}
	});
});

describe('canUseControl', () => {
	it('disables everything while the sandbox is not usable', () => {
		expect(canUseControl('start-order', context({ sandboxUsable: false }))).toBe(false);
		expect(
			canUseControl(
				'query-status',
				context({ sandboxUsable: false, phase: ORDER_STATUS.Preparing })
			)
		).toBe(false);
	});

	it('disables everything while the Temporal server is stopped', () => {
		expect(
			canUseControl(
				'accept-restaurant',
				context({ serverOnline: false, phase: ORDER_STATUS.AwaitingRestaurant })
			)
		).toBe(false);
		expect(
			canUseControl('kill-worker', context({ serverOnline: false, phase: ORDER_STATUS.Preparing }))
		).toBe(false);
	});

	it('only allows start-order while idle and a worker is live', () => {
		expect(canUseControl('start-order', context())).toBe(true);
		expect(canUseControl('start-order', context({ phase: ORDER_STATUS.Preparing }))).toBe(false);
		expect(canUseControl('start-order', context({ phase: ORDER_STATUS.Delivered }))).toBe(false);
		// A fresh workflow needs a worker to advance it, so idle-but-worker-down is gated.
		expect(canUseControl('start-order', context({ workerOnline: false }))).toBe(false);
	});

	it('gates lifecycle signals to their phases', () => {
		expect(
			canUseControl('accept-restaurant', context({ phase: ORDER_STATUS.AwaitingRestaurant }))
		).toBe(true);
		expect(canUseControl('accept-restaurant', context({ phase: ORDER_STATUS.Preparing }))).toBe(
			false
		);
		expect(canUseControl('food-ready', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
		expect(canUseControl('food-ready', context({ phase: ORDER_STATUS.InDelivery }))).toBe(false);
	});

	it('keeps update-address enabled in delivery so the validator rejection can be shown', () => {
		expect(canUseControl('update-address', context({ phase: ORDER_STATUS.InDelivery }))).toBe(true);
		expect(canUseControl('update-address', context({ phase: ORDER_STATUS.Delivered }))).toBe(false);
	});

	it('lets signals through while the worker is down (they append to history)', () => {
		expect(
			canUseControl(
				'accept-restaurant',
				context({ phase: ORDER_STATUS.AwaitingRestaurant, workerOnline: false })
			)
		).toBe(true);
	});

	it('gates worker-served controls (queries, updates, delivery, kill) on a live worker', () => {
		expect(
			canUseControl(
				'complete-delivery',
				context({ phase: ORDER_STATUS.InDelivery, workerOnline: false })
			)
		).toBe(false);
		expect(canUseControl('complete-delivery', context({ phase: ORDER_STATUS.InDelivery }))).toBe(
			true
		);
		expect(
			canUseControl('kill-worker', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
		expect(canUseControl('kill-worker', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
		// Queries and updates are served/validated by the worker, so they gate too.
		expect(
			canUseControl('query-status', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
		expect(
			canUseControl(
				'query-timeline',
				context({ phase: ORDER_STATUS.Preparing, workerOnline: false })
			)
		).toBe(false);
		expect(
			canUseControl(
				'update-address',
				context({ phase: ORDER_STATUS.InDelivery, workerOnline: false })
			)
		).toBe(false);
		expect(
			canUseControl('apply-promo', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
	});

	it('keeps server-side visibility available without a worker, unlike worker-served queries', () => {
		for (const phase of [ORDER_STATUS.Created, ORDER_STATUS.Delivered] as SessionPhase[]) {
			expect(canUseControl('query-status', context({ phase }))).toBe(true);
			expect(canUseControl('list-visibility', context({ phase }))).toBe(true);
		}
		expect(canUseControl('query-status', context())).toBe(false);
		// Visibility hits the server-side Search Attribute index, so it survives a worker outage
		// while the worker-served query does not.
		expect(
			canUseControl(
				'list-visibility',
				context({ phase: ORDER_STATUS.Preparing, workerOnline: false })
			)
		).toBe(true);
		expect(
			canUseControl('query-status', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
	});

	it('allows cancel only while the run is active', () => {
		expect(canUseControl('cancel-order', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
		expect(canUseControl('cancel-order', context({ phase: ORDER_STATUS.Delivered }))).toBe(false);
	});
});

describe('demo payloads', () => {
	it('builds a fresh order with a unique id and the demo restaurant', () => {
		const first = buildDemoOrder();
		const second = buildDemoOrder();
		expect(first.orderId).not.toBe(second.orderId);
		expect(first.restaurantId).toBe('kitchen-44');
		expect(first.items.length).toBeGreaterThan(0);
		expect(first.visibilitySearchAttributesEnabled).toBe(true);
	});

	it('rebuilds the order behind a running workflow from its workflow id', () => {
		const restored = buildDemoOrder('order-restored-1');
		expect(restored.orderId).toBe('order-restored-1');
		expect(restored.restaurantId).toBe('kitchen-44');
	});

	it('derives the child delivery workflow id from the order id', () => {
		expect(deliveryWorkflowIdFor('abc-123')).toBe('delivery-abc-123');
	});

	it('supplies a complete replacement address', () => {
		expect(DEMO_UPDATED_ADDRESS.street.length).toBeGreaterThan(0);
		expect(DEMO_UPDATED_ADDRESS.postalCode.length).toBeGreaterThan(0);
	});

	it('formats cents as US dollars', () => {
		expect(formatMoney(500)).toBe('$5.00');
		expect(formatMoney(1234)).toBe('$12.34');
	});
});

describe('executionPointerFor', () => {
	it('returns no pointer while idle', () => {
		expect(executionPointerFor('idle', true, false)).toBeNull();
	});

	it('maps every order phase to a real anchor in order-workflow.ts (anti-drift)', () => {
		for (const phase of Object.values(ORDER_STATUS)) {
			const pointer = executionPointerFor(phase, true, false);
			expect(pointer, `phase ${phase} should have a pointer`).not.toBeNull();
			expect(pointer!.file).toBe('order-workflow.ts');
			expect(
				orderWorkflowSource.includes(pointer!.anchor),
				`anchor for ${phase} (${pointer!.anchor}) must exist in sandbox-template/order-workflow.ts`
			).toBe(true);
		}
	});

	it('reflects worker liveness in the pointer state', () => {
		expect(executionPointerFor(ORDER_STATUS.Preparing, true, false)?.state).toBe('running');
		expect(executionPointerFor(ORDER_STATUS.Preparing, false, false)?.state).toBe('paused');
		expect(executionPointerFor(ORDER_STATUS.Preparing, false, true)?.state).toBe('replaying');
	});

	it('distinguishes validation and payment inside the shared Validating status', () => {
		expect(
			executionPointerFor(ORDER_STATUS.Validating, true, false, [
				describedEntry(ORDER_STATUS.Validating, 1, 'Validating order')
			])?.anchor
		).toBe('await validateOrder(currentInput);');

		expect(
			executionPointerFor(ORDER_STATUS.Validating, true, false, [
				describedEntry(ORDER_STATUS.Validating, 2, 'Charging payment')
			])?.anchor
		).toBe('await chargePayment(');

		expect(
			executionPointerFor(ORDER_STATUS.Validating, true, false, [
				describedEntry(ORDER_STATUS.Validating, 1, 'Validating order'),
				describedEntry(ORDER_STATUS.Validating, 2, 'Charging payment'),
				describedEntry(ORDER_STATUS.Validating, 3, 'Cancel requested: customer changed plans')
			])?.anchor
		).toBe('await chargePayment(');
	});
});

describe('status chips', () => {
	it('maps order phases to stage labels', () => {
		expect(orderStageLabel('idle')).toBe('not started');
		expect(orderStageLabel(ORDER_STATUS.AwaitingRestaurant)).toBe('awaiting restaurant');
		expect(orderStageLabel(ORDER_STATUS.InDelivery)).toBe('out for delivery');
		expect(orderStageLabel(ORDER_STATUS.Delivered)).toBe('delivered');
	});

	it('maps order phases to dot colors', () => {
		expect(orderStageDot('idle')).toBe('neutral');
		expect(orderStageDot(ORDER_STATUS.Preparing)).toBe('accent');
		expect(orderStageDot(ORDER_STATUS.Delivered)).toBe('success');
	});

	it('maps workflow lifecycle to a tag and dot', () => {
		expect(workflowTag('idle')).toBe('idle');
		expect(workflowTag(ORDER_STATUS.Preparing)).toBe('running');
		expect(workflowTag(ORDER_STATUS.Refunded)).toBe('completed');
		expect(workflowDot(ORDER_STATUS.Preparing)).toBe('accent');
		expect(workflowDot(ORDER_STATUS.Delivered)).toBe('success');
	});

	it('maps sandbox statuses to dot colors', () => {
		expect(sandboxDot('ready')).toBe('online');
		expect(sandboxDot('provisioning')).toBe('pending');
		expect(sandboxDot('authentication-required')).toBe('warning');
		expect(sandboxDot('error')).toBe('danger');
		expect(sandboxDot('unknown-status')).toBe('neutral');
	});
});
