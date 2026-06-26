/**
 * proxy.test.ts — TDD tests for the reverse-proxy core.
 *
 * Uses a stub `fetch` (vi.stubGlobal) as a recording fake upstream so that:
 *  1. We can assert what was sent *to* the upstream (headers, body).
 *  2. We can assert what is returned *to* the browser (headers, body).
 * No real network or E2B infrastructure required.
 *
 * Runs in the "server" vitest project (node environment).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { proxyRequest } from './proxy.ts';
import type { ProxyError } from '$lib/contracts/proxy';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const UPSTREAM_ORIGIN = 'https://8233-abcdef.e2b.dev';
const ACCESS_TOKEN = 'tok-e2b-secret-never-browser';
const SANDBOX_ID = 'sbx-test-abc';
const PROXY_PREFIX = `/sbx/${SANDBOX_ID}/ui`;

function makeRequest(options: RequestInit = {}): Request {
	return new Request(`https://app.test/sbx/${SANDBOX_ID}/ui/`, {
		method: 'GET',
		...options
	});
}

type StubOptions = {
	status?: number;
	headers?: Record<string, string>;
};

/** Registers a mock global `fetch` that returns a canned response. */
function stubFetch(body: string, opts: StubOptions = {}): ReturnType<typeof vi.fn> {
	const mock = vi.fn().mockResolvedValue(
		new Response(body, {
			status: opts.status ?? 200,
			headers: { 'content-type': 'text/plain', ...opts.headers }
		})
	);
	vi.stubGlobal('fetch', mock);
	return mock;
}

/** Reads headers from the first call to a mock fetch. */
function capturedHeaders(mock: ReturnType<typeof vi.fn>): Headers {
	const init = mock.mock.calls[0][1] as RequestInit & { headers?: unknown };
	if (init.headers instanceof Headers) return init.headers;
	return new Headers(init.headers as HeadersInit | undefined);
}

function defaultParams() {
	return {
		upstreamOrigin: UPSTREAM_ORIGIN,
		accessToken: ACCESS_TOKEN,
		sandboxId: SANDBOX_ID,
		path: '',
		proxyPrefix: PROXY_PREFIX,
		request: makeRequest()
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proxyRequest — token security', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('injects e2b-traffic-access-token into the upstream request', async () => {
		const mock = stubFetch('ok');
		await proxyRequest(defaultParams());
		expect(capturedHeaders(mock).get('e2b-traffic-access-token')).toBe(ACCESS_TOKEN);
	});

	it('never echoes e2b-traffic-access-token to the browser as a response header', async () => {
		// Adversarial: upstream echoes the token back in its response headers.
		stubFetch('ok', { headers: { 'e2b-traffic-access-token': ACCESS_TOKEN } });
		const response = await proxyRequest(defaultParams());
		expect(response.headers.get('e2b-traffic-access-token')).toBeNull();
	});

	it('strips e2b-traffic-access-token even when upstream sets it on HTML responses', async () => {
		stubFetch('<html></html>', {
			headers: {
				'content-type': 'text/html',
				'e2b-traffic-access-token': ACCESS_TOKEN
			}
		});
		const response = await proxyRequest(defaultParams());
		expect(response.headers.get('e2b-traffic-access-token')).toBeNull();
	});
});

describe('proxyRequest — request forwarding', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('forwards the upstream status code to the browser', async () => {
		stubFetch('not found', { status: 404 });
		const response = await proxyRequest(defaultParams());
		expect(response.status).toBe(404);
	});

	it('streams non-HTML/JSON body bytes unchanged', async () => {
		stubFetch('binary-blob', { headers: { 'content-type': 'application/octet-stream' } });
		const response = await proxyRequest(defaultParams());
		expect(await response.text()).toBe('binary-blob');
	});

	it('buffers and forwards the POST request body upstream', async () => {
		const mock = stubFetch('accepted', { status: 202 });
		const request = makeRequest({
			method: 'POST',
			body: JSON.stringify({ signal: 'cancel' }),
			headers: { 'content-type': 'application/json' }
		});
		await proxyRequest({ ...defaultParams(), request });
		const init = mock.mock.calls[0][1] as RequestInit;
		// Body must have been buffered (an ArrayBuffer) and passed upstream.
		expect(init.body).toBeInstanceOf(ArrayBuffer);
	});

	it('sends no body for GET requests', async () => {
		const mock = stubFetch('ok');
		await proxyRequest(defaultParams());
		const init = mock.mock.calls[0][1] as RequestInit;
		expect(init.body).toBeUndefined();
	});
});

describe('proxyRequest — URL rewriting', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('rewrites absolute upstream URLs in HTML responses', async () => {
		const html = `<link href="${UPSTREAM_ORIGIN}/a.css"><script src="${UPSTREAM_ORIGIN}/b.js"></script>`;
		stubFetch(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

		const response = await proxyRequest(defaultParams());
		const body = await response.text();
		expect(body).not.toContain(UPSTREAM_ORIGIN);
		expect(body).toContain(`${PROXY_PREFIX}/a.css`);
		expect(body).toContain(`${PROXY_PREFIX}/b.js`);
	});

	it('rewrites absolute upstream URLs in JSON responses', async () => {
		const json = JSON.stringify({ baseUrl: `${UPSTREAM_ORIGIN}/api`, self: UPSTREAM_ORIGIN });
		stubFetch(json, { headers: { 'content-type': 'application/json' } });

		const response = await proxyRequest(defaultParams());
		const body = await response.text();
		expect(body).not.toContain(UPSTREAM_ORIGIN);
		expect(body).toContain(`${PROXY_PREFIX}/api`);
	});

	it('does not rewrite non-HTML/JSON bodies', async () => {
		const text = `config: ${UPSTREAM_ORIGIN}/path`;
		stubFetch(text, { headers: { 'content-type': 'text/plain' } });

		const response = await proxyRequest(defaultParams());
		// text/plain is streamed through; upstream origin is preserved
		expect(await response.text()).toBe(text);
	});
});

describe('proxyRequest — embeddable headers', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('strips X-Frame-Options from the upstream response', async () => {
		stubFetch('ok', { headers: { 'x-frame-options': 'DENY' } });
		const response = await proxyRequest(defaultParams());
		expect(response.headers.get('x-frame-options')).toBeNull();
	});

	it("sets Content-Security-Policy: frame-ancestors 'self' on every response", async () => {
		stubFetch('ok');
		const response = await proxyRequest(defaultParams());
		expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
	});

	it("overrides any upstream Content-Security-Policy with frame-ancestors 'self'", async () => {
		stubFetch('ok', { headers: { 'content-security-policy': "frame-ancestors 'none'" } });
		const response = await proxyRequest(defaultParams());
		expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
	});
});

describe('proxyRequest — hop-by-hop headers', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('does not forward the Connection header upstream', async () => {
		const mock = stubFetch('ok');
		const request = makeRequest({ headers: { connection: 'keep-alive' } });
		await proxyRequest({ ...defaultParams(), request });
		expect(capturedHeaders(mock).get('connection')).toBeNull();
	});

	it('does not forward the Host header upstream', async () => {
		const mock = stubFetch('ok');
		const request = makeRequest({ headers: { host: 'app.test' } });
		await proxyRequest({ ...defaultParams(), request });
		expect(capturedHeaders(mock).get('host')).toBeNull();
	});

	it('forces Accept-Encoding: identity upstream regardless of browser preference', async () => {
		const mock = stubFetch('ok');
		const request = makeRequest({ headers: { 'accept-encoding': 'gzip, br' } });
		await proxyRequest({ ...defaultParams(), request });
		expect(capturedHeaders(mock).get('accept-encoding')).toBe('identity');
	});

	it('strips content-length from proxied responses', async () => {
		stubFetch('<html></html>', {
			headers: { 'content-type': 'text/html', 'content-length': '14' }
		});
		const response = await proxyRequest(defaultParams());
		// Content-length is stripped so rewritten bodies are never truncated.
		expect(response.headers.get('content-length')).toBeNull();
	});
});

describe('proxyRequest — upstream errors', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns 502 with a typed ProxyError when the upstream is unreachable', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

		const response = await proxyRequest(defaultParams());
		expect(response.status).toBe(502);

		const payload = (await response.json()) as ProxyError;
		expect(payload.status).toBe(502);
		expect(payload.sandboxId).toBe(SANDBOX_ID);
		expect(payload.message).toBe('ECONNREFUSED');
		expect(payload.timestamp).toBeTruthy();
	});

	it('returns 502 ProxyError with an ISO timestamp', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
		const response = await proxyRequest(defaultParams());
		const payload = (await response.json()) as ProxyError;
		expect(() => new Date(payload.timestamp)).not.toThrow();
		expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
	});

	it('forwards non-2xx upstream status codes to the browser', async () => {
		stubFetch('bad gateway', { status: 503 });
		const response = await proxyRequest(defaultParams());
		expect(response.status).toBe(503);
	});
});
