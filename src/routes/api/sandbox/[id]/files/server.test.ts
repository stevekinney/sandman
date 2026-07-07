/**
 * +server.test.ts — unit tests for POST /api/sandbox/[id]/files
 * Runs in the "server" vitest project (node environment).
 *
 * Exercises the route handler directly: validates request body shapes,
 * enforces the read-only guard on shared.ts, returns 503 when the
 * resolver is not configured, and verifies the happy-path wiring between
 * the route, writeAndRestart, and the injected SandboxClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _configureSandboxResolver as configureSandboxResolver, POST } from './+server.ts';
import type { SandboxClient, SandboxHandle, WorkerStatus } from '$lib/contracts/sandbox';
import { requireOwnedSandbox, touchSessionActivity } from '$lib/server/security/guards';

vi.mock('$lib/server/security/origin', () => ({
	assertSameOrigin: vi.fn()
}));

vi.mock('$lib/server/security/guards', () => ({
	requireOwnedSandbox: vi.fn().mockResolvedValue('session-id'),
	touchSessionActivity: vi.fn().mockResolvedValue(undefined)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RequestEvent that satisfies the handler's usage of params + request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(id: string, body: unknown): any {
	return {
		params: { id },
		request: new Request('http://localhost/api/sandbox/' + id + '/files', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}

/** Build a RequestEvent with a raw, non-JSON body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRawEvent(id: string, rawBody: string): any {
	return {
		params: { id },
		request: new Request('http://localhost/api/sandbox/' + id + '/files', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: rawBody
		})
	};
}

/** Stub SandboxClient with controllable mock functions. */
function makeClient(overrides?: Partial<SandboxClient>): SandboxClient {
	return {
		provision: vi.fn(),
		bootstrap: vi.fn(),
		restartWorker: vi.fn(),
		killWorker: vi.fn(),
		exec: vi.fn(),
		extendTimeout: vi.fn(),
		writeFile: vi.fn().mockResolvedValue(undefined),
		terminate: vi.fn(),
		...overrides
	} as unknown as SandboxClient;
}

/** Stub SandboxHandle. */
function makeHandle(id = 'handle-1'): SandboxHandle {
	return {
		id,
		status: 'Ready',
		host: () => 'localhost',
		accessToken: 'token'
	} as unknown as SandboxHandle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/sandbox/[id]/files', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset to unconfigured state so tests that don't configure a resolver
		// get the expected 503 behaviour.
		configureSandboxResolver(async () => {
			throw new Error('Sandbox resolver not configured');
		});
	});

	describe('request body validation', () => {
		it('returns 400 for a non-JSON body', async () => {
			const event = makeRawEvent('sandbox-1', 'not valid json {{');
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});

		it('returns 400 when body is missing the path field', async () => {
			const event = makeEvent('sandbox-1', { contents: 'code' });
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});

		it('returns 400 when body is missing the contents field', async () => {
			const event = makeEvent('sandbox-1', { path: 'workflows.ts' });
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});

		it('returns 400 when body is an empty object', async () => {
			const event = makeEvent('sandbox-1', {});
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});
	});

	describe('read-only guard', () => {
		it('returns 403 for shared.ts without calling writeFile', async () => {
			const writeFile = vi.fn().mockResolvedValue(undefined);
			const handle = makeHandle();
			configureSandboxResolver(async () => ({
				client: makeClient({ writeFile }),
				handle
			}));

			const event = makeEvent('sandbox-1', { path: 'shared.ts', contents: 'anything' });
			await expect(POST(event)).rejects.toMatchObject({ status: 403 });
			// Guard must fire before the resolver is reached
			expect(writeFile).not.toHaveBeenCalled();
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});
	});

	describe('allowlist guard', () => {
		it('returns 400 for a path that is not a known editable file', async () => {
			const writeFile = vi.fn().mockResolvedValue(undefined);
			configureSandboxResolver(async () => ({
				client: makeClient({ writeFile }),
				handle: makeHandle()
			}));

			const event = makeEvent('sandbox-1', { path: 'order-workflow.ts.bak', contents: 'x' });
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(writeFile).not.toHaveBeenCalled();
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});

		it('rejects a path-traversal attempt without writing anything', async () => {
			const writeFile = vi.fn().mockResolvedValue(undefined);
			configureSandboxResolver(async () => ({
				client: makeClient({ writeFile }),
				handle: makeHandle()
			}));

			const event = makeEvent('sandbox-1', {
				path: '../../etc/cron.d/pwn',
				contents: '* * * * * root sh'
			});
			await expect(POST(event)).rejects.toMatchObject({ status: 400 });
			expect(writeFile).not.toHaveBeenCalled();
			expect(touchSessionActivity).not.toHaveBeenCalled();
		});
	});

	describe('sandbox resolver', () => {
		it('returns 503 when the resolver throws (unconfigured)', async () => {
			// beforeEach already sets a throwing resolver
			const event = makeEvent('sandbox-1', { path: 'workflow.ts', contents: 'code' });
			await expect(POST(event)).rejects.toMatchObject({ status: 503 });
		});
	});

	describe('happy path', () => {
		it('calls writeFile with the correct handle, path, and contents', async () => {
			const workerStatus: WorkerStatus = { ok: true, phase: 'ready' };
			const writeFile = vi.fn().mockResolvedValue(undefined);
			const restartWorker = vi.fn().mockResolvedValue(workerStatus);
			const handle = makeHandle('h1');

			configureSandboxResolver(async () => ({
				client: makeClient({ writeFile, restartWorker }),
				handle
			}));

			const event = makeEvent('sandbox-1', {
				path: 'workflow.ts',
				contents: 'workflow code'
			});
			await POST(event);

			expect(writeFile).toHaveBeenCalledWith(handle, 'workflow.ts', 'workflow code');
		});

		it('returns the WorkerStatus from restartWorker as JSON', async () => {
			const workerStatus: WorkerStatus = { ok: false, phase: 'compile-error', stderr: 'TS2345' };
			const restartWorker = vi.fn().mockResolvedValue(workerStatus);

			configureSandboxResolver(async () => ({
				client: makeClient({ restartWorker }),
				handle: makeHandle()
			}));

			const event = makeEvent('sandbox-1', { path: 'activities.ts', contents: 'code' });
			const response = await POST(event);
			const result = await response.json();

			expect(result).toEqual(workerStatus);
		});

		it('passes the sandbox ID from params to the resolver', async () => {
			const resolve = vi.fn().mockResolvedValue({
				client: makeClient({
					restartWorker: vi.fn().mockResolvedValue({ ok: true, phase: 'ready' })
				}),
				handle: makeHandle()
			});
			configureSandboxResolver(resolve);

			const event = makeEvent('my-specific-sandbox', { path: 'worker.ts', contents: 'code' });
			await POST(event);

			expect(resolve).toHaveBeenCalledWith('my-specific-sandbox');
		});

		it('slides session/sandbox expiry after the ownership guard succeeds (file writes count as activity)', async () => {
			configureSandboxResolver(async () => ({
				client: makeClient({
					restartWorker: vi.fn().mockResolvedValue({ ok: true, phase: 'ready' })
				}),
				handle: makeHandle()
			}));

			const event = makeEvent('sandbox-1', { path: 'workflow.ts', contents: 'code' });
			await POST(event);

			expect(requireOwnedSandbox).toHaveBeenCalledWith(event, 'sandbox-1');
			expect(touchSessionActivity).toHaveBeenCalledWith(event, 'sandbox-1');
		});
	});
});
