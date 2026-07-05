/**
 * fetch-controller.spec.ts
 *
 * Unit tests for FetchController — the HTTP-backed TemporalController.
 * Stubs `fetch` globally; no network, no E2B, no Temporal server needed.
 *
 * Critical path: update() with HTTP 422 must throw UpdateRejectionError
 * (not a generic Error) so the UI can display the rejection reason inline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchController } from './fetch-controller.ts';
import { isUpdateRejectionError } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown, contentType = 'application/json'): Response {
	const encoded = contentType === 'application/json' ? JSON.stringify(body) : String(body);
	return new Response(encoded, {
		status,
		headers: { 'Content-Type': contentType }
	});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	// query() uses `new URL(..., window.location.href)` — stub window in Node.
	vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('FetchController.start', () => {
	it('POSTs to /api/sandbox/[id]/workflow and returns the parsed WorkflowRun', async () => {
		const run = { workflowId: 'wf-1', runId: 'run-1' };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, run)));

		const controller = new FetchController('sandbox-abc');
		const result = await controller.start({
			orderId: 'ord-1',
			restaurantId: 'rest-1',
			customerId: 'cust-1',
			customerTier: 'standard',
			items: [{ itemId: 'item-1', name: 'Pizza', quantity: 1, unitPriceCents: 1099 }],
			deliveryAddress: {
				street: '1 Main St',
				city: 'Springfield',
				state: 'IL',
				postalCode: '62701'
			},
			paymentMethod: { type: 'card', last4: '4242', brand: 'Visa' }
		});

		expect(result).toEqual(run);
		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sandbox/sandbox-abc/workflow',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('throws an Error when the response is not ok', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))
		);

		const controller = new FetchController('sandbox-abc');
		await expect(controller.start({} as never)).rejects.toThrow('Failed to start workflow');
	});

	it('extracts a readable message from JSON error responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(mockResponse(500, { message: 'Internal Error' }))
		);

		const controller = new FetchController('sandbox-abc');

		await expect(controller.start({} as never)).rejects.toThrow(
			'Failed to start workflow: Internal Error'
		);
	});
});

// ---------------------------------------------------------------------------
// signal()
// ---------------------------------------------------------------------------

describe('FetchController.signal', () => {
	it('POSTs to /api/sandbox/[id]/workflow/signal', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, {})));

		const controller = new FetchController('sandbox-xyz');
		await controller.signal('wf-1', 'cancelOrder', { reason: 'changed mind' });

		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sandbox/sandbox-xyz/workflow/signal',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					workflowId: 'wf-1',
					name: 'cancelOrder',
					payload: { reason: 'changed mind' }
				})
			})
		);
	});

	it('throws an Error when the response is not ok', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('signal error', { status: 500 }))
		);

		const controller = new FetchController('sandbox-abc');
		await expect(controller.signal('wf-1', 'cancelOrder', { reason: 'x' })).rejects.toThrow(
			'Signal cancelOrder failed'
		);
	});
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe('FetchController.query', () => {
	it('GETs /api/sandbox/[id]/workflow/query with workflowId and name params', async () => {
		const payload = { status: 'PREPARING', totalCents: 1099 };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, payload)));

		const controller = new FetchController('sandbox-abc');
		const result = await controller.query('wf-1', 'getStatus');

		expect(result).toEqual(payload);
		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
		expect(calledUrl).toMatch(/workflowId=wf-1/);
		expect(calledUrl).toMatch(/name=getStatus/);
	});

	it('throws an Error when the response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('query error', { status: 503 })));

		const controller = new FetchController('sandbox-abc');
		await expect(controller.query('wf-1', 'getStatus')).rejects.toThrow('Query getStatus failed');
	});
});

// ---------------------------------------------------------------------------
// update() — critical path: 422 → UpdateRejectionError
// ---------------------------------------------------------------------------

describe('FetchController.update', () => {
	it('throws an UpdateRejectionError (not a generic Error) when the server responds 422', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockResponse(422, { reason: 'Delivery address is outside service area' })
				)
		);

		const controller = new FetchController('sandbox-abc');

		let thrown: unknown;
		try {
			await controller.update('wf-1', 'updateDeliveryAddress', {
				newAddress: { street: '999 Far Away Rd', city: 'Nowhere', state: 'AK', postalCode: '99999' }
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeDefined();
		expect(isUpdateRejectionError(thrown)).toBe(true);
		expect((thrown as { reason: string }).reason).toBe('Delivery address is outside service area');
	});

	it('does NOT throw an UpdateRejectionError for other 4xx errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
		);

		const controller = new FetchController('sandbox-abc');
		let thrown: unknown;
		try {
			await controller.update('wf-1', 'updateDeliveryAddress', {} as never);
		} catch (err) {
			thrown = err;
		}

		expect(isUpdateRejectionError(thrown)).toBe(false);
		expect(thrown).toBeInstanceOf(Error);
	});

	it('returns the parsed result on success', async () => {
		const result = { applied: true };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, result)));

		const controller = new FetchController('sandbox-abc');
		const response = await controller.update('wf-1', 'applyPromoCode', { code: 'SAVE10' });

		expect(response).toEqual(result);
	});
});

// ---------------------------------------------------------------------------
// killWorker() / restartWorker()
// ---------------------------------------------------------------------------

describe('FetchController.killWorker', () => {
	it('POSTs to /api/sandbox/[id]/worker/kill', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, {})));

		const controller = new FetchController('sandbox-abc');
		await controller.killWorker();

		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/sandbox-abc/worker/kill', {
			method: 'POST'
		});
	});

	it('throws when the response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));

		const controller = new FetchController('sandbox-abc');
		await expect(controller.killWorker()).rejects.toThrow('Kill worker failed');
	});
});

describe('FetchController.restartWorker', () => {
	it('POSTs to /api/sandbox/[id]/worker/restart', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, {})));

		const controller = new FetchController('sandbox-abc');
		await controller.restartWorker();

		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/sandbox-abc/worker/restart', {
			method: 'POST'
		});
	});

	it('throws when the response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));

		const controller = new FetchController('sandbox-abc');
		await expect(controller.restartWorker()).rejects.toThrow('Restart worker failed');
	});
});

// ---------------------------------------------------------------------------
// readProcessLiveness()
// ---------------------------------------------------------------------------

describe('FetchController.readProcessLiveness', () => {
	it('GETs /api/sandbox/[id]/status and returns the processes liveness', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockResponse(200, {
					status: 'ready',
					processes: { serverOnline: true, workerOnline: false }
				})
			)
		);

		const controller = new FetchController('sandbox-abc');
		const liveness = await controller.readProcessLiveness();

		expect(liveness).toEqual({ serverOnline: true, workerOnline: false });
		const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
		expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/sandbox-abc/status');
	});

	it('treats a null/absent processes field as fully offline', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(mockResponse(200, { status: 'ready', processes: null }))
		);

		const controller = new FetchController('sandbox-abc');
		const liveness = await controller.readProcessLiveness();

		expect(liveness).toEqual({ serverOnline: false, workerOnline: false });
	});

	it('treats a malformed processes field as fully offline rather than trusting it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockResponse(200, {
					status: 'ready',
					processes: { serverOnline: 'yes', workerOnline: 1 }
				})
			)
		);

		const controller = new FetchController('sandbox-abc');
		const liveness = await controller.readProcessLiveness();

		expect(liveness).toEqual({ serverOnline: false, workerOnline: false });
	});

	it('throws when the status response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 503 })));

		const controller = new FetchController('sandbox-abc');
		await expect(controller.readProcessLiveness()).rejects.toThrow('Read sandbox status failed');
	});
});
