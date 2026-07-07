/**
 * session-restore.test.ts — unit tests for the reload-restoration logic:
 * resumable-workflow detection and the phase → tour-step floor mapping.
 * The full restore flow against a real SessionState is covered in
 * session-state.svelte.spec.ts (client project).
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowSummary } from '$lib/contracts/workflow-api';
import { ORDER_WORKFLOW, ORDER_STATUS } from '$lib/contracts/workflow-api';
import { TOUR } from '$lib/content/demo-script';
import type { SessionPhase } from './session-actions.ts';
import {
	isOrderWorkflowSummary,
	isResumableOrderWorkflow,
	minimumTourStepIndexForPhase
} from './session-restore.ts';

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
	return {
		workflowId: 'order-1',
		runId: 'run-1',
		status: 'RUNNING',
		type: ORDER_WORKFLOW,
		...overrides
	};
}

describe('isOrderWorkflowSummary', () => {
	it('accepts an order workflow regardless of status', () => {
		expect(isOrderWorkflowSummary(summary())).toBe(true);
		expect(isOrderWorkflowSummary(summary({ status: 'COMPLETED' }))).toBe(true);
		expect(isOrderWorkflowSummary(summary({ status: 'CANCELED' }))).toBe(true);
	});

	it('rejects untyped summaries', () => {
		expect(isOrderWorkflowSummary(summary({ type: undefined }))).toBe(false);
		expect(isOrderWorkflowSummary(summary({ type: 'someOtherWorkflow' }))).toBe(false);
	});
});

describe('isResumableOrderWorkflow', () => {
	it('accepts a running order workflow regardless of status casing', () => {
		expect(isResumableOrderWorkflow(summary())).toBe(true);
		expect(isResumableOrderWorkflow(summary({ status: 'Running' }))).toBe(true);
	});

	it('rejects finished runs and untyped summaries', () => {
		expect(isResumableOrderWorkflow(summary({ status: 'COMPLETED' }))).toBe(false);
		expect(isResumableOrderWorkflow(summary({ type: undefined }))).toBe(false);
	});
});

describe('minimumTourStepIndexForPhase', () => {
	function stepIdAtFloor(phase: SessionPhase): string | undefined {
		return TOUR[minimumTourStepIndexForPhase(phase)]?.id;
	}

	it('keeps a fresh session at the first step', () => {
		expect(minimumTourStepIndexForPhase('idle')).toBe(0);
	});

	it('floors each active phase at the earliest step still consistent with it', () => {
		expect(stepIdAtFloor(ORDER_STATUS.Received)).toBe('activities-run');
		expect(stepIdAtFloor(ORDER_STATUS.WaitingForRestaurant)).toBe('signal-accept');
		expect(stepIdAtFloor(ORDER_STATUS.Preparing)).toBe('query-status');
	});

	it('does not force-complete durable-recovery or complete-delivery just because the order is delivered', () => {
		// The run can finish without the worker ever having been killed, so
		// Delivered must not silently mark durable-recovery/complete-delivery
		// done — stepStuckAtTerminal + skip() (session-state.svelte.ts) is the
		// path for that, offering an explicit skip instead of a silent one.
		expect(stepIdAtFloor(ORDER_STATUS.Delivered)).toBe('query-status');
	});

	it('does not force progress for cancelled or refunded orders', () => {
		expect(minimumTourStepIndexForPhase(ORDER_STATUS.Cancelled)).toBe(0);
		expect(minimumTourStepIndexForPhase(ORDER_STATUS.Refunded)).toBe(0);
	});
});
