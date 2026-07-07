import { error } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server.ts';
import { assertSameOrigin } from '$lib/server/security/origin';
import { touchSessionHeartbeat } from '$lib/server/security/guards';

vi.mock('$lib/server/security/origin', () => ({
	assertSameOrigin: vi.fn()
}));

vi.mock('$lib/server/security/guards', () => ({
	touchSessionHeartbeat: vi.fn().mockResolvedValue({ sandboxTouched: false })
}));

function makeEvent(rawBody: string | undefined, origin = 'http://localhost') {
	const event = {
		url: new URL('http://localhost/api/session/heartbeat'),
		request: new Request('http://localhost/api/session/heartbeat', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json' },
			body: rawBody
		}),
		cookies: { get: vi.fn(), set: vi.fn() }
	};
	return event as unknown as Parameters<typeof POST>[0] & typeof event;
}

describe('POST /api/session/heartbeat', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('enforces the same-origin check', async () => {
		await POST(makeEvent(JSON.stringify({ sandboxId: 'sandbox-1' })));
		expect(assertSameOrigin).toHaveBeenCalledOnce();
	});

	it('rejects a mismatched origin before touching the session', async () => {
		vi.mocked(assertSameOrigin).mockImplementationOnce(() => {
			throw error(403, 'Origin does not match request host');
		});

		await expect(POST(makeEvent(JSON.stringify({ sandboxId: 'sandbox-1' })))).rejects.toMatchObject(
			{
				status: 403
			}
		);
		expect(touchSessionHeartbeat).not.toHaveBeenCalled();
	});

	it('forwards a string sandboxId from the body to touchSessionHeartbeat', async () => {
		const event = makeEvent(JSON.stringify({ sandboxId: 'sandbox-1' }));
		await POST(event);
		expect(touchSessionHeartbeat).toHaveBeenCalledWith(event, 'sandbox-1');
	});

	it('treats an empty body as no sandboxId (200, not 400)', async () => {
		const event = makeEvent(undefined);
		const response = await POST(event);
		expect(response.status).toBe(200);
		expect(touchSessionHeartbeat).toHaveBeenCalledWith(event, undefined);
	});

	it('treats a malformed/non-JSON body as no sandboxId (200, not 400)', async () => {
		const event = makeEvent('not json{');
		const response = await POST(event);
		expect(response.status).toBe(200);
		expect(touchSessionHeartbeat).toHaveBeenCalledWith(event, undefined);
	});

	it('treats a non-string sandboxId field as no sandboxId', async () => {
		const event = makeEvent(JSON.stringify({ sandboxId: 42 }));
		await POST(event);
		expect(touchSessionHeartbeat).toHaveBeenCalledWith(event, undefined);
	});

	it('propagates a thrown auth/ownership error from touchSessionHeartbeat', async () => {
		vi.mocked(touchSessionHeartbeat).mockImplementationOnce(async () => {
			throw error(401, 'Demo session is no longer active');
		});
		await expect(POST(makeEvent(JSON.stringify({ sandboxId: 'sandbox-1' })))).rejects.toMatchObject(
			{
				status: 401
			}
		);
	});

	it('returns json({ ok: true, sandboxTouched }) reflecting the heartbeat result', async () => {
		vi.mocked(touchSessionHeartbeat).mockResolvedValueOnce({ sandboxTouched: true });
		const response = await POST(makeEvent(JSON.stringify({ sandboxId: 'sandbox-1' })));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, sandboxTouched: true });
	});
});
