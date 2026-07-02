/**
 * write-and-restart.test.ts — unit tests for the writeAndRestart core route logic.
 * Runs in the "server" vitest project (node environment).
 *
 * Verifies ordering: writeFile MUST be called before restartWorker.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SandboxClient, SandboxHandle, WorkerStatus } from '$lib/contracts/sandbox';
import { SANDBOX_STATUS } from '$lib/contracts/sandbox';
import { writeAndRestart } from './write-and-restart.ts';

/** Build a mock SandboxHandle for testing. */
function makeMockHandle(): SandboxHandle {
	return {
		id: 'sbx-test-123',
		status: SANDBOX_STATUS.Ready,
		host: (port) => `https://localhost:${port}`,
		accessToken: 'test-token'
	};
}

describe('writeAndRestart', () => {
	it('calls writeFile then restartWorker in that exact order', async () => {
		const invocationOrder: string[] = [];

		const mockClient: SandboxClient = {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec: vi.fn(),
			terminate: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			writeFile: vi.fn(async () => {
				invocationOrder.push('writeFile');
			}),
			restartWorker: vi.fn(async (): Promise<WorkerStatus> => {
				invocationOrder.push('restartWorker');
				return { ok: true, phase: 'ready' };
			})
		};

		const handle = makeMockHandle();
		await writeAndRestart(mockClient, handle, { path: 'workflows.ts', contents: 'export {};' });

		expect(invocationOrder).toEqual(['writeFile', 'restartWorker']);
	});

	it('passes the correct handle, path, and contents to writeFile', async () => {
		const mockClient: SandboxClient = {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec: vi.fn(),
			terminate: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			writeFile: vi.fn(async () => {}),
			restartWorker: vi.fn(async (): Promise<WorkerStatus> => ({ ok: true, phase: 'ready' }))
		};

		const handle = makeMockHandle();
		const path = 'activities.ts';
		const contents = 'export const myActivity = async () => {};';

		await writeAndRestart(mockClient, handle, { path, contents });

		expect(mockClient.writeFile).toHaveBeenCalledWith(handle, path, contents);
	});

	it('passes the correct handle to restartWorker', async () => {
		const mockClient: SandboxClient = {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec: vi.fn(),
			terminate: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			writeFile: vi.fn(async () => {}),
			restartWorker: vi.fn(async (): Promise<WorkerStatus> => ({ ok: true, phase: 'ready' }))
		};

		const handle = makeMockHandle();
		await writeAndRestart(mockClient, handle, { path: 'worker.ts', contents: '' });

		expect(mockClient.restartWorker).toHaveBeenCalledWith(handle);
	});

	it('returns the WorkerStatus from restartWorker', async () => {
		const expectedStatus: WorkerStatus = { ok: false, phase: 'compile-error', stderr: 'TS2345' };

		const mockClient: SandboxClient = {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec: vi.fn(),
			terminate: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			writeFile: vi.fn(async () => {}),
			restartWorker: vi.fn(async (): Promise<WorkerStatus> => expectedStatus)
		};

		const handle = makeMockHandle();
		const result = await writeAndRestart(mockClient, handle, {
			path: 'workflows.ts',
			contents: 'bad code'
		});

		expect(result).toEqual(expectedStatus);
	});

	it('propagates writeFile errors without calling restartWorker', async () => {
		const mockClient: SandboxClient = {
			provision: vi.fn(),
			bootstrap: vi.fn(),
			stopServer: vi.fn(),
			startServer: vi.fn(),
			exec: vi.fn(),
			terminate: vi.fn(),
			killWorker: vi.fn(),
			processLiveness: vi.fn(() => null),
			writeFile: vi.fn(async () => {
				throw new Error('E2B write failed');
			}),
			restartWorker: vi.fn(async (): Promise<WorkerStatus> => ({ ok: true, phase: 'ready' }))
		};

		const handle = makeMockHandle();
		await expect(
			writeAndRestart(mockClient, handle, { path: 'workflows.ts', contents: '' })
		).rejects.toThrow('E2B write failed');

		expect(mockClient.restartWorker).not.toHaveBeenCalled();
	});
});
