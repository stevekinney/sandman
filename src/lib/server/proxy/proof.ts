/**
 * proof.ts — integration proof for the Temporal Web UI proxy.
 *
 * Boots a real E2B sandbox, starts a trivial HTTP responder on port 8233,
 * and asserts that:
 *  1. The proxy fetches the upstream URL with `e2b-traffic-access-token` injected.
 *  2. The browser-side response never contains that header.
 *  3. The response body is forwarded correctly.
 *
 * GATED on `E2B_API_KEY` — if the key is not set this module exits with 0.
 * This is intentional: the proof runs in CI only when an E2B key is available.
 *
 * Usage (from the project root):
 *   E2B_API_KEY=<key> bun run src/lib/server/proxy/proof.ts
 */

import { Sandbox } from 'e2b';
import { proxyRequest } from './proxy';

const E2B_API_KEY = process.env['E2B_API_KEY'];

function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

if (!E2B_API_KEY) {
	log('[proof] E2B_API_KEY not set — skipping integration proof.');
	process.exit(0);
}

/**
 * Runs the integration proof:
 *  1. Boot a sandbox.
 *  2. Start a trivial HTTP server on port 8233 inside the sandbox that echoes
 *     the value of the `e2b-traffic-access-token` header in its response body.
 *  3. Call `proxyRequest` targeting that endpoint.
 *  4. Assert the browser response never contains the token.
 *  5. Assert the upstream received the token (body equals the token string).
 */
async function runProof(): Promise<void> {
	log('[proof] Booting sandbox…');
	const sandbox = await Sandbox.create({
		apiKey: E2B_API_KEY,
		timeoutMs: 60_000
	});

	try {
		const sandboxId = sandbox.sandboxId;
		const accessToken = sandbox.trafficAccessToken ?? '';

		// A tiny Node.js HTTP server that echoes the token header in its body.
		// This lets us assert, in one round-trip, both that the token was injected
		// upstream and that the proxy body-forwarding path is correct.
		const serverScript = [
			"import http from 'http';",
			'const server = http.createServer((req, res) => {',
			"  res.writeHead(200, { 'content-type': 'text/plain' });",
			"  res.end(req.headers['e2b-traffic-access-token'] ?? 'NO_TOKEN');",
			'});',
			"server.listen(8233, () => process.stdout.write('listening\\n'));"
		].join('\n');

		await sandbox.files.write('/tmp/proof-server.mjs', serverScript);
		await sandbox.commands.run('node /tmp/proof-server.mjs &', { background: true });

		// Give the server a moment to bind.
		await new Promise((resolve) => setTimeout(resolve, 500));

		const upstreamHost = sandbox.getHost(8233);
		const upstreamOrigin = upstreamHost.startsWith('http')
			? upstreamHost
			: `https://${upstreamHost}`;

		const request = new Request(`https://app.test/sbx/${sandboxId}/ui/`);
		const response = await proxyRequest({
			upstreamOrigin,
			accessToken,
			sandboxId,
			path: '',
			proxyPrefix: `/sbx/${sandboxId}/ui`,
			request
		});

		// Assert: response is not a 502 (upstream was reachable).
		if (response.status !== 200) {
			throw new Error(`[proof] Unexpected status ${response.status} — upstream may be unreachable`);
		}

		// Assert: the upstream received the token (body echoes it).
		const body = await response.text();
		if (body !== accessToken) {
			throw new Error(
				`[proof] Upstream did not receive the token. Got: "${body}", expected: "${accessToken}"`
			);
		}

		// Assert: token is not present in browser-facing response headers.
		const browserToken = response.headers.get('e2b-traffic-access-token');
		if (browserToken !== null) {
			throw new Error(
				`[proof] SECURITY VIOLATION: e2b-traffic-access-token present in browser response header: "${browserToken}"`
			);
		}

		log('[proof] All assertions passed.');
		log('  ✓ Upstream received the access token.');
		log('  ✓ Browser response does not contain the access token header.');
		log('  ✓ Response body forwarded correctly.');
	} finally {
		await sandbox.kill();
		log('[proof] Sandbox terminated.');
	}
}

runProof().catch((err: unknown) => {
	process.stderr.write(`[proof] FAILED: ${String(err)}\n`);
	process.exit(1);
});
