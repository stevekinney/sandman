/**
 * contracts.spec.ts — type-level and runtime unit tests for all four contract files.
 * Runs in the "server" vitest project (node environment).
 *
 * Every describe block pairs `expectTypeOf` checks with a runtime `expect`
 * assertion so `expect.requireAssertions` is satisfied.
 */

import { describe, expect, it, expectTypeOf } from 'vitest';

import {
	SANDBOX_STATUS,
	type SandboxStatus,
	type SandboxHandle,
	type WorkerStatus,
	type ExecResult,
	type SandboxClient
} from './sandbox.ts';

import {
	ORDER_STATUS,
	QUERY_NAMES,
	SCENARIOS,
	SCENARIO_ID,
	SIGNAL_NAMES,
	TASK_QUEUE,
	ORDER_WORKFLOW,
	type OrderStatus,
	type ScenarioId,
	type SignalName,
	type QueryName,
	type FeatureId,
	type WorkflowSummary
} from './workflow-api.ts';

import {
	ORDER_STATUS as SHARED_ORDER_STATUS,
	SIGNAL_NAMES as SHARED_SIGNAL_NAMES,
	QUERY_NAMES as SHARED_QUERY_NAMES,
	TASK_QUEUE as SHARED_TASK_QUEUE,
	ORDER_WORKFLOW as SHARED_ORDER_WORKFLOW
} from '../../../sandbox-template/shared.ts';

import {
	PROXIED_UI_PORT,
	ALLOWED_UPSTREAM_PORTS,
	type ProxiedUiRouteParams,
	type ProxyError
} from './proxy.ts';

import {
	WORKFLOW_EVENT_CATEGORY,
	type WorkflowEventCategory,
	type WorkflowEvent
} from './events.ts';

// ---------------------------------------------------------------------------
// sandbox.ts
// ---------------------------------------------------------------------------

describe('SANDBOX_STATUS', () => {
	it('has all six expected lifecycle values', () => {
		const values = Object.values(SANDBOX_STATUS);
		expect(values).toContain('Provisioning');
		expect(values).toContain('Bootstrapping');
		expect(values).toContain('Ready');
		expect(values).toContain('Restarting');
		expect(values).toContain('Terminated');
		expect(values).toContain('Error');
		expect(values).toHaveLength(6);
	});

	it('Ready value is the string literal "Ready"', () => {
		expect(SANDBOX_STATUS.Ready).toBe('Ready');
		expectTypeOf(SANDBOX_STATUS.Ready).toEqualTypeOf<'Ready'>();
	});
});

describe('SandboxStatus type', () => {
	it('accepts all valid status strings', () => {
		const statuses: SandboxStatus[] = Object.values(SANDBOX_STATUS);
		expect(statuses).toHaveLength(6);
		expectTypeOf<SandboxStatus>().toEqualTypeOf<
			'Provisioning' | 'Bootstrapping' | 'Ready' | 'Restarting' | 'Terminated' | 'Error'
		>();
	});
});

describe('ExecResult type', () => {
	it('has required numeric exitCode and string fields', () => {
		const result: ExecResult = { exitCode: 0, stdout: 'ok', stderr: '' };
		expect(result.exitCode).toBe(0);
		expectTypeOf(result.exitCode).toEqualTypeOf<number>();
		expectTypeOf(result.stdout).toEqualTypeOf<string>();
	});
});

describe('SandboxHandle type', () => {
	it('host field is a function from number to string', () => {
		const handle: SandboxHandle = {
			id: 'test-id',
			status: SANDBOX_STATUS.Ready,
			host: (port) => `https://sandbox-${port}.example.com`,
			accessToken: 'tok'
		};
		expect(handle.host(8233)).toBe('https://sandbox-8233.example.com');
		expectTypeOf(handle.host).toEqualTypeOf<(port: number) => string>();
	});
});

describe('WorkerStatus type', () => {
	it('ok is a boolean and phase is a string union', () => {
		const status: WorkerStatus = { ok: true, phase: 'ready' };
		expect(status.ok).toBe(true);
		expectTypeOf(status.phase).toEqualTypeOf<'restarting' | 'ready' | 'compile-error'>();
	});
});

describe('SandboxClient interface', () => {
	it('all required methods are present in the type', () => {
		// Structural check — build a minimal mock that satisfies the interface at compile time.
		const mockClient: SandboxClient = {
			provision: async () => ({
				id: 'id',
				status: SANDBOX_STATUS.Provisioning,
				host: () => 'http://localhost',
				accessToken: ''
			}),
			bootstrap: async () => ({ ready: true, uiUrl: 'http://localhost:8233' }),
			restartWorker: async () => ({ ok: true, phase: 'ready' }),
			killWorker: async () => {},
			stopServer: async () => {},
			startServer: async () => {},
			processLiveness: () => null,
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			extendTimeout: async () => {},
			writeFile: async () => {},
			terminate: async () => {},
			terminateById: async () => {}
		};
		expect(typeof mockClient.provision).toBe('function');
		expect(typeof mockClient.bootstrap).toBe('function');
		expect(typeof mockClient.restartWorker).toBe('function');
		expect(typeof mockClient.killWorker).toBe('function');
		expect(typeof mockClient.stopServer).toBe('function');
		expect(typeof mockClient.startServer).toBe('function');
		expect(typeof mockClient.processLiveness).toBe('function');
		expect(typeof mockClient.exec).toBe('function');
		expect(typeof mockClient.extendTimeout).toBe('function');
		expect(typeof mockClient.writeFile).toBe('function');
		expect(typeof mockClient.terminate).toBe('function');
		expect(typeof mockClient.terminateById).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// workflow-api.ts
// ---------------------------------------------------------------------------

describe('ORDER_STATUS', () => {
	it('has all six order lifecycle values', () => {
		const values = Object.values(ORDER_STATUS);
		expect(values).toContain('RECEIVED');
		expect(values).toContain('WAITING_FOR_RESTAURANT');
		expect(values).toContain('PREPARING');
		expect(values).toContain('DELIVERED');
		expect(values).toContain('REFUNDED');
		expect(values).toContain('CANCELLED');
		expect(values).toHaveLength(6);
	});

	it('Delivered value is the string literal "DELIVERED"', () => {
		expect(ORDER_STATUS.Delivered).toBe('DELIVERED');
		expectTypeOf(ORDER_STATUS.Delivered).toEqualTypeOf<'DELIVERED'>();
	});
});

describe('OrderStatus type', () => {
	it('accepts all valid order status strings', () => {
		const statuses: OrderStatus[] = Object.values(ORDER_STATUS);
		expect(statuses).toHaveLength(6);
	});
});

describe('SignalName / QueryName types', () => {
	it('are string types matching the workflow-api.ts contract', () => {
		expectTypeOf<SignalName>().toEqualTypeOf<
			'restaurantAccepted' | 'deliveryCompleted' | 'cancelOrder'
		>();
		expectTypeOf<QueryName>().toEqualTypeOf<'getStatus'>();

		// Runtime assertion so requireAssertions is satisfied
		const signal: SignalName = 'cancelOrder';
		const query: QueryName = 'getStatus';
		expect(signal).toBe('cancelOrder');
		expect(query).toBe('getStatus');
	});
});

describe('FeatureId type', () => {
	it('includes all six features from the workflow-api.ts contract', () => {
		const feature: FeatureId = 'activities-retry';
		expect(feature).toBe('activities-retry');
		expectTypeOf<FeatureId>().toEqualTypeOf<
			| 'activities-retry'
			| 'non-retryable-failure'
			| 'signals'
			| 'queries'
			| 'timers-durable-sleep'
			| 'durable-recovery'
		>();
	});
});

describe('workflow message allowlists', () => {
	it('exports runtime allowlists for API route validation', () => {
		expect(SIGNAL_NAMES).toEqual(['restaurantAccepted', 'deliveryCompleted', 'cancelOrder']);
		expect(QUERY_NAMES).toEqual(['getStatus']);
	});
});

describe('WorkflowSummary type', () => {
	it('has workflowId, runId, and status strings with an optional type', () => {
		const summary: WorkflowSummary = {
			workflowId: 'order-1',
			runId: 'run-1',
			status: 'RUNNING',
			type: 'orderWorkflow'
		};
		expect(summary.workflowId).toBe('order-1');
		expectTypeOf(summary.workflowId).toEqualTypeOf<string>();
		expectTypeOf(summary.type).toEqualTypeOf<string | undefined>();
	});
});

describe('SCENARIOS', () => {
	it('defines the guided workshop scenario ids', () => {
		expect(Object.values(SCENARIO_ID)).toEqual([
			'happy-path',
			'retry',
			'timeout-refund',
			'worker-recovery'
		]);
		expectTypeOf<ScenarioId>().toEqualTypeOf<
			'happy-path' | 'retry' | 'timeout-refund' | 'worker-recovery'
		>();
	});

	it('has mechanically verifiable steps for every scenario', () => {
		expect(SCENARIOS).toHaveLength(4);
		for (const scenario of SCENARIOS) {
			expect(scenario.title.length).toBeGreaterThan(0);
			expect(scenario.summary.length).toBeGreaterThan(0);
			expect(scenario.steps.length).toBeGreaterThan(0);
			for (const step of scenario.steps) {
				expect(step.id.length).toBeGreaterThan(0);
				expect(step.featureId.length).toBeGreaterThan(0);
				expect(step.completesOn.length).toBeGreaterThan(0);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// proxy.ts
// ---------------------------------------------------------------------------

describe('PROXIED_UI_PORT', () => {
	it('is exactly 8233', () => {
		expect(PROXIED_UI_PORT).toBe(8233);
		expectTypeOf(PROXIED_UI_PORT).toEqualTypeOf<8233>();
	});
});

describe('ALLOWED_UPSTREAM_PORTS', () => {
	it('contains only 8233', () => {
		expect(ALLOWED_UPSTREAM_PORTS).toEqual([8233]);
		expect(ALLOWED_UPSTREAM_PORTS).toHaveLength(1);
	});
});

describe('ProxiedUiRouteParams type', () => {
	it('has id as string and path as string array', () => {
		const params: ProxiedUiRouteParams = { id: 'sbx-abc', path: ['api', 'namespaces'] };
		expect(params.id).toBe('sbx-abc');
		expect(params.path).toEqual(['api', 'namespaces']);
		expectTypeOf(params.id).toEqualTypeOf<string>();
		expectTypeOf(params.path).toEqualTypeOf<string[]>();
	});
});

describe('ProxyError type', () => {
	it('is 502 when the upstream is unreachable', () => {
		const err: ProxyError = {
			status: 502,
			message: 'upstream unreachable',
			sandboxId: 'sbx-abc',
			timestamp: new Date().toISOString()
		};
		expect(err.status).toBe(502);
		expectTypeOf(err.status).toEqualTypeOf<502 | 504>();
	});

	it('is 504 when the upstream times out', () => {
		const err: ProxyError = {
			status: 504,
			message: 'upstream did not respond within 30000ms',
			sandboxId: 'sbx-abc',
			timestamp: new Date().toISOString()
		};
		expect(err.status).toBe(504);
	});
});

// ---------------------------------------------------------------------------
// events.ts
// ---------------------------------------------------------------------------

describe('WORKFLOW_EVENT_CATEGORY', () => {
	it('has all twelve expected categories', () => {
		const values = Object.values(WORKFLOW_EVENT_CATEGORY);
		expect(values).toContain('started');
		expect(values).toContain('signal');
		expect(values).toContain('query');
		expect(values).toContain('update');
		expect(values).toContain('timer');
		expect(values).toContain('activity');
		expect(values).toContain('child');
		expect(values).toContain('compensation');
		expect(values).toContain('completed');
		expect(values).toContain('failed');
		expect(values).toContain('terminated');
		expect(values).toContain('worker');
		expect(values).toHaveLength(12);
	});

	it('Worker category is the string "worker"', () => {
		expect(WORKFLOW_EVENT_CATEGORY.Worker).toBe('worker');
		expectTypeOf(WORKFLOW_EVENT_CATEGORY.Worker).toEqualTypeOf<'worker'>();
	});
});

describe('WorkflowEventCategory type', () => {
	it('is a string union of all category values', () => {
		const category: WorkflowEventCategory = 'compensation';
		expect(category).toBe('compensation');
	});
});

describe('WorkflowEvent type', () => {
	it('has required sequence, type, and timestamp fields', () => {
		const event: WorkflowEvent = {
			sequence: 1,
			type: 'WorkflowExecutionStarted',
			timestamp: '2026-01-01T00:00:00.000Z',
			workflowId: 'order-123',
			payload: { orderId: 'order-123' }
		};
		expect(event.sequence).toBe(1);
		expect(event.type).toBe('WorkflowExecutionStarted');
		expectTypeOf(event.sequence).toEqualTypeOf<number>();
		expectTypeOf(event.timestamp).toEqualTypeOf<string>();
	});
});

// ---------------------------------------------------------------------------
// workflow-api.ts <-> sandbox-template/shared.ts parity (anti-drift)
// ---------------------------------------------------------------------------

describe('workflow-api.ts <-> sandbox-template/shared.ts parity', () => {
	it('ORDER_STATUS values match exactly between the two mirrors', () => {
		expect(Object.values(SHARED_ORDER_STATUS)).toEqual(Object.values(ORDER_STATUS));
	});

	it('TASK_QUEUE and ORDER_WORKFLOW match exactly between the two mirrors', () => {
		expect(SHARED_TASK_QUEUE).toBe(TASK_QUEUE);
		expect(SHARED_ORDER_WORKFLOW).toBe(ORDER_WORKFLOW);
	});

	it('SIGNAL_NAMES and QUERY_NAMES match exactly between the two mirrors', () => {
		expect(SHARED_SIGNAL_NAMES).toEqual(SIGNAL_NAMES);
		expect(SHARED_QUERY_NAMES).toEqual(QUERY_NAMES);
	});
});
