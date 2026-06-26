/**
 * temporal-ui-proxy.e2e.ts — end-to-end Playwright tests for the proxy route.
 *
 * Tests what is verifiable without a live E2B sandbox:
 *  - The route exists and responds at the expected path.
 *  - When no sandbox is registered (default state), the route returns a typed
 *    502 ProxyError with the correct JSON shape.
 *  - The error response never includes `e2b-traffic-access-token`.
 *
 * Full proxy round-trip tests (with a live upstream) are covered by the unit
 * tests in src/lib/server/proxy/proxy.test.ts via a recording fake fetch.
 * The proof module (src/lib/server/proxy/proof.ts) exercises the real path
 * when E2B_API_KEY is set.
 */

import { expect, test } from '@playwright/test';
import type { ProxyError } from '../src/lib/contracts/proxy';

test('GET /sbx/[id]/ui/ returns 502 ProxyError when sandbox is not registered', async ({
	request
}) => {
	const response = await request.get('/sbx/nonexistent-sandbox/ui/');
	expect(response.status()).toBe(502);

	const body = (await response.json()) as ProxyError;
	expect(body.status).toBe(502);
	expect(typeof body.message).toBe('string');
	expect(body.sandboxId).toBe('nonexistent-sandbox');
	expect(typeof body.timestamp).toBe('string');
	// Timestamp must be valid ISO-8601.
	expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
});

test('GET /sbx/[id]/ui/nested/path returns 502 ProxyError with correct sandboxId', async ({
	request
}) => {
	const response = await request.get('/sbx/sbx-test-id/ui/api/namespaces');
	expect(response.status()).toBe(502);

	const body = (await response.json()) as ProxyError;
	expect(body.status).toBe(502);
	expect(body.sandboxId).toBe('sbx-test-id');
});

test('proxy error response never exposes e2b-traffic-access-token header', async ({ request }) => {
	const response = await request.get('/sbx/any-sandbox-id/ui/');
	// The token must never appear in the browser-facing response headers.
	const tokenHeader = response.headers()['e2b-traffic-access-token'];
	expect(tokenHeader).toBeUndefined();
});

test('POST /sbx/[id]/ui/ also returns 502 ProxyError when sandbox is not registered', async ({
	request
}) => {
	const response = await request.post('/sbx/no-sandbox/ui/', {
		data: JSON.stringify({}),
		headers: { 'content-type': 'application/json' }
	});
	expect(response.status()).toBe(502);

	const body = (await response.json()) as ProxyError;
	expect(body.status).toBe(502);
	expect(body.sandboxId).toBe('no-sandbox');
});
