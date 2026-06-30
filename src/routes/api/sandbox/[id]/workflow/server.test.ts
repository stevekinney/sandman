import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { resolveEntry } from '$lib/server/sandbox/registry';

vi.mock('$lib/server/security/origin', () => ({
	assertSameOrigin: vi.fn()
}));

vi.mock('$lib/server/security/guards', () => ({
	requireOwnedSandbox: vi.fn().mockResolvedValue('session-1')
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	resolveEntry: vi.fn()
}));

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
				exec,
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
});
