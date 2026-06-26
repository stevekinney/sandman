/**
 * url-rewriter.test.ts — unit tests for absolute upstream URL rewriting.
 * Runs in the "server" vitest project (node environment).
 */

import { describe, expect, it } from 'vitest';
import { rewriteUrls } from './url-rewriter.ts';

const UPSTREAM = 'https://8233-abcdef.e2b.dev';
const PREFIX = '/sbx/test-id/ui';

describe('rewriteUrls', () => {
	it('rewrites an absolute upstream URL in an HTML href attribute', () => {
		const html = `<a href="${UPSTREAM}/api/namespaces">link</a>`;
		expect(rewriteUrls(html, UPSTREAM, PREFIX)).toBe(`<a href="${PREFIX}/api/namespaces">link</a>`);
	});

	it('rewrites an absolute upstream URL in an HTML src attribute', () => {
		const html = `<script src="${UPSTREAM}/app.js"></script>`;
		expect(rewriteUrls(html, UPSTREAM, PREFIX)).toBe(`<script src="${PREFIX}/app.js"></script>`);
	});

	it('rewrites all occurrences in the same document', () => {
		const html = `<link href="${UPSTREAM}/a.css"><script src="${UPSTREAM}/b.js"></script>`;
		const result = rewriteUrls(html, UPSTREAM, PREFIX);
		expect(result).toBe(`<link href="${PREFIX}/a.css"><script src="${PREFIX}/b.js"></script>`);
	});

	it('leaves relative paths untouched', () => {
		const html = `<a href="/api/namespaces">relative</a>`;
		expect(rewriteUrls(html, UPSTREAM, PREFIX)).toBe(html);
	});

	it('rewrites absolute upstream URLs in JSON string values', () => {
		const json = JSON.stringify({ baseUrl: `${UPSTREAM}/api` });
		const result = rewriteUrls(json, UPSTREAM, PREFIX);
		expect(result).toBe(JSON.stringify({ baseUrl: `${PREFIX}/api` }));
	});

	it('tolerates a trailing slash on upstreamOrigin', () => {
		const html = `<a href="${UPSTREAM}/path">x</a>`;
		expect(rewriteUrls(html, `${UPSTREAM}/`, PREFIX)).toBe(`<a href="${PREFIX}/path">x</a>`);
	});

	it('returns text unchanged when no upstream URLs are present', () => {
		const html = `<a href="https://unrelated.example.com/other">unrelated</a>`;
		expect(rewriteUrls(html, UPSTREAM, PREFIX)).toBe(html);
	});

	it('rewrites the bare origin with no path suffix', () => {
		const json = JSON.stringify({ origin: UPSTREAM });
		expect(rewriteUrls(json, UPSTREAM, PREFIX)).toBe(JSON.stringify({ origin: PREFIX }));
	});
});
