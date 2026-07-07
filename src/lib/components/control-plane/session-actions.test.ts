/**
 * session-actions.test.ts — unit tests for the pure workbench logic:
 * phase derivation, control gating, demo payloads, event inference, and chip
 * mappings.
 */
import { describe, expect, it } from 'vitest';
import type { OrderStatus, TimelineEntry } from '$lib/contracts/workflow-api';
import { ORDER_STATUS } from '$lib/contracts/workflow-api';
import workflowSource from '../../../../sandbox-template/workflow.ts?raw';
import {
	DEMO_ORDER_DEFAULTS,
	buildDemoOrder,
	canUseControl,
	derivePhase,
	executionPointerFor,
	formatMoney,
	inferWorkflowEventType,
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
	return { timestamp: new Date(index * 1000).toISOString(), description: 'entry', status };
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

	it('reads as Received once started but before the first timeline entry', () => {
		expect(derivePhase(true, [])).toBe(ORDER_STATUS.Received);
	});

	it('tracks the latest timeline entry status', () => {
		const entries = [entry(ORDER_STATUS.Received, 0), entry(ORDER_STATUS.Preparing, 1)];
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
			ORDER_STATUS.Received,
			ORDER_STATUS.WaitingForRestaurant,
			ORDER_STATUS.Preparing
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
				context({ serverOnline: false, phase: ORDER_STATUS.WaitingForRestaurant })
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
			canUseControl('accept-restaurant', context({ phase: ORDER_STATUS.WaitingForRestaurant }))
		).toBe(true);
		expect(canUseControl('accept-restaurant', context({ phase: ORDER_STATUS.Preparing }))).toBe(
			false
		);
		expect(canUseControl('complete-delivery', context({ phase: ORDER_STATUS.Preparing }))).toBe(
			true
		);
		expect(canUseControl('complete-delivery', context({ phase: ORDER_STATUS.Delivered }))).toBe(
			false
		);
	});

	it('lets signals through while the worker is down (they append to history)', () => {
		expect(
			canUseControl(
				'accept-restaurant',
				context({ phase: ORDER_STATUS.WaitingForRestaurant, workerOnline: false })
			)
		).toBe(true);
		expect(
			canUseControl('cancel-order', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(true);
	});

	it('gates worker-served controls (queries, kill) on a live worker', () => {
		expect(
			canUseControl('query-status', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
		expect(canUseControl('query-status', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
		expect(
			canUseControl('kill-worker', context({ phase: ORDER_STATUS.Preparing, workerOnline: false }))
		).toBe(false);
		expect(canUseControl('kill-worker', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
	});

	it('allows cancel only while the run is active', () => {
		expect(canUseControl('cancel-order', context({ phase: ORDER_STATUS.Preparing }))).toBe(true);
		expect(canUseControl('cancel-order', context({ phase: ORDER_STATUS.Delivered }))).toBe(false);
	});
});

describe('demo payloads', () => {
	it('builds a fresh order with a unique id and the canned items', () => {
		const first = buildDemoOrder();
		const second = buildDemoOrder();
		expect(first.orderId).not.toBe(second.orderId);
		expect(first.cardLast4).toBe(DEMO_ORDER_DEFAULTS.cardLast4);
		expect(first.items).toEqual([
			{ name: 'Spicy noodles', quantity: 1, priceCents: 1295 },
			{ name: 'Ginger lime soda', quantity: 1, priceCents: 425 }
		]);
	});

	it('rebuilds the order behind a running workflow from its workflow id', () => {
		const restored = buildDemoOrder('order-restored-1');
		expect(restored.orderId).toBe('order-restored-1');
		expect(restored.items.length).toBeGreaterThan(0);
	});

	it('formats cents as US dollars', () => {
		expect(formatMoney(500)).toBe('$5.00');
		expect(formatMoney(1234)).toBe('$12.34');
	});
});

describe('inferWorkflowEventType', () => {
	function infer(previous: OrderStatus | undefined, status: OrderStatus) {
		return inferWorkflowEventType(previous, {
			timestamp: new Date().toISOString(),
			description: 'entry',
			status
		});
	}

	it('returns undefined for the first entry (no previous status)', () => {
		expect(infer(undefined, ORDER_STATUS.Received)).toBeUndefined();
	});

	it('maps a second RECEIVED entry to the payment activity completing', () => {
		expect(infer(ORDER_STATUS.Received, ORDER_STATUS.Received)).toBe('ActivityTaskCompleted');
	});

	it('maps entering WAITING_FOR_RESTAURANT to the durable timer starting', () => {
		expect(infer(ORDER_STATUS.Received, ORDER_STATUS.WaitingForRestaurant)).toBe('TimerStarted');
	});

	it('maps entering PREPARING to the restaurant-accepted signal', () => {
		expect(infer(ORDER_STATUS.WaitingForRestaurant, ORDER_STATUS.Preparing)).toBe(
			'WorkflowExecutionSignaled'
		);
	});

	it('maps entering DELIVERED to workflow completion', () => {
		expect(infer(ORDER_STATUS.Preparing, ORDER_STATUS.Delivered)).toBe(
			'WorkflowExecutionCompleted'
		);
	});

	it('maps entering REFUNDED to the deadline timer firing', () => {
		expect(infer(ORDER_STATUS.WaitingForRestaurant, ORDER_STATUS.Refunded)).toBe('TimerFired');
	});

	it('maps RECEIVED to CANCELLED as a failed payment activity', () => {
		expect(infer(ORDER_STATUS.Received, ORDER_STATUS.Cancelled)).toBe('ActivityTaskFailed');
	});

	it('maps WAITING_FOR_RESTAURANT or PREPARING to CANCELLED as the cancel signal', () => {
		expect(infer(ORDER_STATUS.WaitingForRestaurant, ORDER_STATUS.Cancelled)).toBe(
			'WorkflowExecutionSignaled'
		);
		expect(infer(ORDER_STATUS.Preparing, ORDER_STATUS.Cancelled)).toBe('WorkflowExecutionSignaled');
	});
});

describe('executionPointerFor', () => {
	it('returns no pointer while idle', () => {
		expect(executionPointerFor('idle', true, false)).toBeNull();
	});

	it('maps every order status to a real anchor in workflow.ts (anti-drift)', () => {
		for (const phase of Object.values(ORDER_STATUS)) {
			const pointer = executionPointerFor(phase, true, false);
			expect(pointer, `phase ${phase} should have a pointer`).not.toBeNull();
			expect(pointer!.file).toBe('workflow.ts');
			expect(
				workflowSource.includes(pointer!.anchor),
				`anchor for ${phase} (${pointer!.anchor}) must exist in sandbox-template/workflow.ts`
			).toBe(true);
		}
	});

	it('reflects worker liveness in the pointer state', () => {
		expect(executionPointerFor(ORDER_STATUS.Preparing, true, false)?.state).toBe('running');
		expect(executionPointerFor(ORDER_STATUS.Preparing, false, false)?.state).toBe('paused');
		expect(executionPointerFor(ORDER_STATUS.Preparing, false, true)?.state).toBe('replaying');
	});
});

describe('status chips', () => {
	it('maps order phases to stage labels', () => {
		expect(orderStageLabel('idle')).toBe('not started');
		expect(orderStageLabel(ORDER_STATUS.WaitingForRestaurant)).toBe('awaiting restaurant');
		expect(orderStageLabel(ORDER_STATUS.Preparing)).toBe('preparing');
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
