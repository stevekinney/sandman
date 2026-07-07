import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { GET as LIST_GET } from './list/+server';
import { GET as QUERY_GET } from './query/+server';
import { POST as SIGNAL_POST } from './signal/+server';
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

function mockSandboxExec(stdout: string, exitCode = 0): ReturnType<typeof vi.fn> {
	const writeFile = vi.fn().mockResolvedValue(undefined);
	const exec = vi.fn().mockResolvedValue({
		exitCode,
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
			terminate: vi.fn(),
			terminateById: vi.fn()
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
				type: 'orderWorkflow',
				namespace: 'default',
				taskQueue: 'orders'
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
				terminate: vi.fn(),
				terminateById: vi.fn()
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
				cardLast4: '4242',
				items: [{ name: 'Noodles', quantity: 1, priceCents: 1295 }]
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

	it('rejects a missing orderId without invoking Temporal CLI', async () => {
		const response = await POST(makeEvent({ orderId: '', cardLast4: '4242', items: [] }));

		expect(response.status).toBe(400);
		expect(touchSessionActivity).not.toHaveBeenCalled();
	});

	it('rejects a missing cardLast4 without invoking Temporal CLI', async () => {
		const response = await POST(
			makeEvent({
				orderId: 'order-1',
				cardLast4: '',
				items: [{ name: 'Noodles', quantity: 1, priceCents: 1295 }]
			})
		);

		expect(response.status).toBe(400);
		expect(touchSessionActivity).not.toHaveBeenCalled();
	});

	it('rejects empty items without invoking Temporal CLI', async () => {
		const response = await POST(makeEvent({ orderId: 'order-1', cardLast4: '4242', items: [] }));

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
});

describe('GET /api/sandbox/[id]/workflow/list', () => {
	it('lists workflows via `temporal workflow list -o json`', async () => {
		const exec = mockSandboxExec(
			JSON.stringify({
				executions: [
					{
						execution: { workflowId: 'order-1', runId: 'run-1' },
						type: { name: 'orderWorkflow' },
						status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED'
					}
				]
			})
		);

		const response = await LIST_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/list') as Parameters<typeof LIST_GET>[0]
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			workflows: [
				{
					workflowId: 'order-1',
					runId: 'run-1',
					status: 'COMPLETED',
					type: 'orderWorkflow'
				}
			]
		});
		expect(exec).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('temporal workflow list'),
			expect.anything()
		);
	});

	it('returns 502 when the Temporal CLI command fails', async () => {
		mockSandboxExec('boom', 1);

		const response = await LIST_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/list') as Parameters<typeof LIST_GET>[0]
		);

		expect(response.status).toBe(502);
	});

	it('returns 502 when the Temporal CLI returns invalid JSON', async () => {
		mockSandboxExec('not json');

		const response = await LIST_GET(
			makeRouteEvent('/api/sandbox/sandbox-1/workflow/list') as Parameters<typeof LIST_GET>[0]
		);

		expect(response.status).toBe(502);
	});
});
