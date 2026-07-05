import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { GET as VISIBILITY_GET } from './visibility/+server';
import { GET as QUERY_GET } from './query/+server';
import { POST as SIGNAL_POST } from './signal/+server';
import { POST as UPDATE_POST } from './update/+server';
import { resolveEntry } from '$lib/server/sandbox/registry';
import { touchSessionActivity } from '$lib/server/security/guards';

vi.mock('$lib/server/security/origin', () => ({
	assertSameOrigin: vi.fn()
}));

vi.mock('$lib/server/security/guards', () => ({
	requireOwnedSandbox: vi.fn().mockResolvedValue('session-1'),
	touchSessionActivity: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	resolveEntry: vi.fn()
}));

beforeEach(() => {
	vi.clearAllMocks();
});

function makeEvent(body: unknown): Parameters<typeof POST>[0] {
	return {
		params: { id: 'sandbox-1' },
		url: new URL('http://localhost/api/sandbox/sandbox-1/workflow'),
		request: new Request('http://localhost/api/sandbox/sandbox-1/workflow', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		cookies: {
			get: vi.fn()
		}
	} as unknown as Parameters<typeof POST>[0];
}

function makeRouteEvent(
	route: string,
	options: { method?: string; body?: unknown; search?: Record<string, string> } = {}
): unknown {
	const url = new URL(`http://localhost${route}`);
	for (const [key, value] of Object.entries(options.search ?? {})) {
		url.searchParams.set(key, value);
	}
	return {
		params: { id: 'sandbox-1' },
		url,
		request: new Request(url, {
			method: options.method ?? 'GET',
			body: options.body === undefined ? undefined : JSON.stringify(options.body)
		}),
		cookies: {
			get: vi.fn()
		}
	};
}

function mockSandboxExec(stdout: string): ReturnType<typeof vi.fn> {
	const writeFile = vi.fn().mockResolvedValue(undefined);
	const exec = vi.fn().mockResolvedValue({
		exitCode: 0,
		stdout,
		stderr: ''
	});
	vi.mocked(resolveEntry).mockReturnValue({
		client: {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			restartWorker: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec,
			extendTimeout: vi.fn(),
			writeFile,
			terminate: vi.fn()
		},
		handle: {
			id: 'sandbox-1',
			status: 'Ready',
			host: vi.fn(),
			accessToken: ''
		}
	});
	return exec;
}

describe('POST /api/sandbox/[id]/workflow', () => {
	it('starts workflows through the registered sandbox client', async () => {
		const writeFile = vi.fn().mockResolvedValue(undefined);
		const exec = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({
				workflowId: 'order-1',
				runId: 'run-1',
				type: 'orderFoodWorkflow',
				namespace: 'default',
				taskQueue: 'sandman-food'
			}),
			stderr: ''
		});
		vi.mocked(resolveEntry).mockReturnValue({
			client: {
				provision: vi.fn(),
				bootstrap: vi.fn(),
				restartWorker: vi.fn(),
				killWorker: vi.fn(),
				processLiveness: vi.fn(() => null),
				stopServer: vi.fn(),
				startServer: vi.fn(),
				exec,
				extendTimeout: vi.fn(),
				writeFile,
				terminate: vi.fn()
			},
			handle: {
				id: 'sandbox-1',
				status: 'Ready',
				host: vi.fn(),
				accessToken: ''
			}
		});

		const response = await POST(
			makeEvent({
				orderId: 'order-1',
				restaurantId: 'restaurant-1',
				customerId: 'customer-1',
				customerTier: 'standard',
				items: [{ itemId: 'item-1', name: 'Noodles', quantity: 1, unitPriceCents: 1295 }],
				deliveryAddress: {
					street: '221 Market Street',
					city: 'Denver',
					state: 'CO',
					postalCode: '80205'
				},
				paymentMethod: { type: 'card', last4: '4242', brand: 'Visa' }
			})
		);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({ workflowId: 'order-1', runId: 'run-1' });
		expect(writeFile).toHaveBeenCalledOnce();
		expect(exec).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('temporal workflow start'),
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
		expect(exec).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('--input-file'),
			expect.anything()
		);
	});

	it('does not slide session expiry for invalid workflow start bodies', async () => {
		const response = await POST(
			makeEvent({ orderId: '', restaurantId: 'restaurant-1', items: [] })
		);

		expect(response.status).toBe(400);
		expect(touchSessionActivity).not.toHaveBeenCalled();
	});
});

describe('workflow message route validation', () => {
	it('rejects unknown query names before invoking Temporal CLI', async () => {
		const exec = mockSandboxExec('{}');
		const response = await QUERY_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/query', {
				search: { workflowId: 'order-1', name: 'unknownQuery' }
			}) as Parameters<typeof QUERY_GET>[0]
		);

		expect(response.status).toBe(400);
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects unknown signal names before invoking Temporal CLI', async () => {
		const exec = mockSandboxExec('{}');
		const response = await SIGNAL_POST(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/signal', {
				method: 'POST',
				body: { workflowId: 'order-1', name: 'unknownSignal', payload: {} }
			}) as Parameters<typeof SIGNAL_POST>[0]
		);

		expect(response.status).toBe(400);
		expect(exec).not.toHaveBeenCalled();
		expect(touchSessionActivity).not.toHaveBeenCalled();
	});

	it('rejects unknown update names before invoking Temporal CLI', async () => {
		const exec = mockSandboxExec('{}');
		const response = await UPDATE_POST(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/update', {
				method: 'POST',
				body: { workflowId: 'order-1', name: 'unknownUpdate', input: {} }
			}) as Parameters<typeof UPDATE_POST>[0]
		);

		expect(response.status).toBe(400);
		expect(exec).not.toHaveBeenCalled();
		expect(touchSessionActivity).not.toHaveBeenCalled();
	});
});

describe('GET /api/sandbox/[id]/workflow/visibility', () => {
	it('lists workflows with a Temporal Visibility query', async () => {
		const exec = mockSandboxExec(
			JSON.stringify({
				executions: [
					{
						execution: { workflowId: 'order-1', runId: 'run-1' },
						type: { name: 'orderFoodWorkflow' },
						status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED',
						searchAttributes: {
							indexedFields: {
								OrderStatus: { data: btoa(JSON.stringify(['DELIVERED'])) },
								CustomerTier: { data: btoa(JSON.stringify(['premium'])) },
								RestaurantId: { data: btoa(JSON.stringify(['rest-test'])) }
							}
						}
					}
				]
			})
		);

		const response = await VISIBILITY_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/visibility', {
				search: {
					status: 'DELIVERED',
					customerTier: 'premium',
					restaurantId: 'rest-test'
				}
			}) as Parameters<typeof VISIBILITY_GET>[0]
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			workflows: [
				{
					workflowId: 'order-1',
					runId: 'run-1',
					status: 'COMPLETED',
					type: 'orderFoodWorkflow',
					businessSnapshot: {
						OrderStatus: 'DELIVERED',
						CustomerTier: 'premium',
						RestaurantId: 'rest-test'
					}
				}
			]
		});
		expect(exec).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('OrderStatus='),
			expect.anything()
		);
		expect(exec).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('DELIVERED'),
			expect.anything()
		);
	});

	it('returns a teaching error when Search Attributes are not registered', async () => {
		const exec = vi.fn().mockResolvedValue({
			exitCode: 1,
			stdout: 'invalid search attribute OrderStatus',
			stderr: ''
		});
		vi.mocked(resolveEntry).mockReturnValue({
			client: {
				provision: vi.fn(),
				bootstrap: vi.fn(),
				restartWorker: vi.fn(),
				killWorker: vi.fn(),
				processLiveness: vi.fn(() => null),
				stopServer: vi.fn(),
				startServer: vi.fn(),
				exec,
				extendTimeout: vi.fn(),
				writeFile: vi.fn(),
				terminate: vi.fn()
			},
			handle: {
				id: 'sandbox-1',
				status: 'Ready',
				host: vi.fn(),
				accessToken: ''
			}
		});

		const response = await VISIBILITY_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/visibility', {
				search: { status: 'DELIVERED' }
			}) as Parameters<typeof VISIBILITY_GET>[0]
		);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining('Search Attributes must be registered')
		});
	});

	it('rejects a restaurantId that could break out of the List Filter clause', async () => {
		const exec = mockSandboxExec('{"executions":[]}');

		const response = await VISIBILITY_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/visibility', {
				// A single quote would otherwise escape the RestaurantId='...' clause.
				search: { restaurantId: "rest' AND OrderStatus='Delivered" }
			}) as Parameters<typeof VISIBILITY_GET>[0]
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining('Invalid restaurantId')
		});
		// The malformed filter never reaches the sandbox.
		expect(exec).not.toHaveBeenCalled();
	});
});
