/**
 * smoke.ts — live E2B sandbox smoke test.
 *
 * Run this module directly (e.g. `bun src/lib/server/sandbox/smoke.ts`) to
 * perform a full round-trip: provision → bootstrap → exec → terminate.
 *
 * Without E2B_API_KEY set it prints a clear skip message and exits 0.
 * A hard 5-minute timeout prevents indefinite hangs.
 */

import { createSandboxClient } from './client.ts';
import { createRealE2bAdapter } from './e2b-adapter.ts';

const HARD_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

async function runSmoke(): Promise<void> {
	const apiKey = process.env['E2B_API_KEY'];
	if (!apiKey) {
		console.log('[smoke:sandbox] SKIP — E2B_API_KEY not set.');
		process.exit(0);
	}

	console.log('[smoke:sandbox] Starting live sandbox smoke test…');

	const client = createSandboxClient({
		adapter: createRealE2bAdapter(),
		sandboxTimeoutMs: HARD_TIMEOUT_MS,
		maxReadinessRetries: 90,
		readinessDelayMs: 2_000
	});

	let handle: Awaited<ReturnType<typeof client.provision>> | undefined;

	try {
		// 1. Provision
		console.log('[smoke:sandbox] Provisioning sandbox…');
		handle = await client.provision({ timeoutMs: HARD_TIMEOUT_MS });
		console.log(`[smoke:sandbox] Provisioned: ${handle.id}`);

		// 2. Bootstrap
		console.log('[smoke:sandbox] Bootstrapping…');
		const { ready, uiUrl } = await client.bootstrap(handle);
		console.log(`[smoke:sandbox] Bootstrap ready=${ready} uiUrl=${uiUrl}`);

		if (!ready) {
			throw new Error('Temporal dev server did not become ready in time.');
		}

		// 3. Assert temporal workflow list exits 0
		console.log('[smoke:sandbox] Running "temporal workflow list"…');
		const result = await client.exec(handle, 'temporal workflow list', { timeoutMs: 15_000 });
		console.log(
			`[smoke:sandbox] Exit code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
		);
		if (result.exitCode !== 0) {
			throw new Error(`"temporal workflow list" exited with code ${result.exitCode}`);
		}

		// 4. Assert host(8233) returns a reachable preview URL
		const previewUrl = handle.host(8233);
		console.log(`[smoke:sandbox] Preview URL: ${previewUrl}`);
		if (!previewUrl.startsWith('https://')) {
			throw new Error(`Expected https:// URL, got: ${previewUrl}`);
		}

		console.log('[smoke:sandbox] All assertions passed. ✓');
	} finally {
		if (handle !== undefined) {
			console.log('[smoke:sandbox] Terminating sandbox…');
			await client.terminate(handle);
			console.log('[smoke:sandbox] Terminated.');
		}
	}
}

// Hard timeout guard so the process cannot hang indefinitely.
const timer = setTimeout(() => {
	console.error('[smoke:sandbox] TIMEOUT — exceeded hard limit. Aborting.');
	process.exit(1);
}, HARD_TIMEOUT_MS);

// Don't let the timeout keep the process alive if it finishes early.
timer.unref();

runSmoke().catch((err: unknown) => {
	console.error('[smoke:sandbox] FAILED:', err);
	process.exit(1);
});
