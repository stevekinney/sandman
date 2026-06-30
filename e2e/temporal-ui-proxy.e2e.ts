/**
 * temporal-ui-proxy.e2e.ts — end-to-end Playwright tests for the proxy route.
 *
 * Tests what is verifiable without a live E2B sandbox:
 *  - The route exists and responds at the expected path.
 *  - Unauthenticated browser requests cannot reach the proxy.
 *  - The error response never includes `e2b-traffic-access-token`.
 *
 * Full proxy round-trip tests (with a live upstream) are covered by the unit
 * tests in src/lib/server/proxy/proxy.test.ts via a recording fake fetch.
 * The proof module (src/lib/server/proxy/proof.ts) exercises the real path
 * when E2B_API_KEY is set.
 */

import { expect, test } from '@playwright/test';
test('GET /sbx/[id]/ui/ rejects requests without a demo session', async ({ request }) => {
	const response = await request.get('/sbx/nonexistent-sandbox/ui/');
	expect(response.status()).toBe(401);
});

test('GET /sbx/[id]/ui/nested/path rejects requests without a demo session', async ({
	request
}) => {
	const response = await request.get('/sbx/sbx-test-id/ui/api/namespaces');
	expect(response.status()).toBe(401);
});

test('proxy error response never exposes e2b-traffic-access-token header', async ({ request }) => {
	const response = await request.get('/sbx/any-sandbox-id/ui/');
	// The token must never appear in the browser-facing response headers.
	const tokenHeader = response.headers()['e2b-traffic-access-token'];
	expect(tokenHeader).toBeUndefined();
});

test('POST /sbx/[id]/ui/ rejects requests without a demo session', async ({ request }) => {
	const response = await request.post('/sbx/no-sandbox/ui/', {
		data: JSON.stringify({}),
		headers: { 'content-type': 'application/json' }
	});
	expect(response.status()).toBe(401);
});
