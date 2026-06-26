/**
 * e2b-adapter.spec.ts — unit tests for the E2B SDK wrapper.
 *
 * Uses a minimal duck-typed sandbox mock so no real API key is needed.
 * Verifies wrapSandbox correctly:
 *   - Prepends https:// to getHost()
 *   - Converts CommandExitError to a result object in commands.run()
 *   - Re-throws non-CommandExitError errors
 *   - Returns a handle with the correct pid from commands.start()
 *   - Converts CommandExitError from handle.wait() in commands.start()
 *   - Exposes sandboxId and trafficAccessToken from the underlying sandbox
 */

import { describe, it, expect } from 'vitest';
import { CommandExitError } from 'e2b';
import type { Sandbox } from 'e2b';
import { wrapSandbox } from './e2b-adapter.ts';

// Minimal duck type covering only what wrapSandbox actually accesses.
// Test files may play fast and loose with types per project convention —
// cast to Sandbox at the call site.
type FakeSandbox = {
	sandboxId: string;
	trafficAccessToken?: string;
	getHost(port: number): string;
	commands: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		run(cmd: string, opts?: Record<string, unknown>): Promise<any>;
		kill(pid: number): Promise<boolean>;
	};
	files: {
		write(path: string, data: string): Promise<void>;
	};
	kill(): Promise<boolean>;
};

function makeFakeSandbox(overrides: Partial<FakeSandbox> = {}): FakeSandbox {
	return {
		sandboxId: 'sbx-test',
		trafficAccessToken: 'tok-abc',
		getHost: (port) => `${port}-sbx-test.e2b.dev`,
		commands: {
			run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			kill: async () => true
		},
		files: {
			write: async () => undefined
		},
		kill: async () => true,
		...overrides
	};
}

describe('wrapSandbox', () => {
	it('getHost() prepends https:// to the raw E2B hostname', () => {
		const fake = makeFakeSandbox({
			getHost: (port) => `${port}-sbx-test.e2b.dev`
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		expect(session.getHost(8233)).toBe('https://8233-sbx-test.e2b.dev');
	});

	it('getHost() always prepends exactly one https:// prefix', () => {
		const fake = makeFakeSandbox({
			getHost: () => 'hostname-only.e2b.dev'
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		const url = session.getHost(7233);
		expect(url.startsWith('https://')).toBe(true);
		expect(url.indexOf('https://', 1)).toBe(-1); // no double prefix
	});

	it('commands.run() catches CommandExitError and returns a result object', async () => {
		const fake = makeFakeSandbox({
			commands: {
				run: async () => {
					throw new CommandExitError({ exitCode: 127, stdout: '', stderr: 'command not found' });
				},
				kill: async () => true
			}
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		const result = await session.commands.run('bad-command');
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toBe('command not found');
	});

	it('commands.run() re-throws errors that are not CommandExitError', async () => {
		const fake = makeFakeSandbox({
			commands: {
				run: async () => {
					throw new Error('network timeout');
				},
				kill: async () => true
			}
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		await expect(session.commands.run('any-command')).rejects.toThrow('network timeout');
	});

	it('commands.start() returns a handle with the correct pid', async () => {
		const fake = makeFakeSandbox({
			commands: {
				run: async () => ({
					pid: 42,
					wait: async () => ({ exitCode: 0, stdout: 'done', stderr: '' })
				}),
				kill: async () => true
			}
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		const handle = await session.commands.start('long-running-cmd');
		expect(handle.pid).toBe(42);
	});

	it('commands.start().wait() catches CommandExitError thrown by the underlying handle', async () => {
		const fake = makeFakeSandbox({
			commands: {
				run: async () => ({
					pid: 77,
					wait: async () => {
						throw new CommandExitError({ exitCode: 1, stdout: '', stderr: 'worker crashed' });
					}
				}),
				kill: async () => true
			}
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		const handle = await session.commands.start('worker');
		const result = await handle.wait();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('worker crashed');
	});

	it('exposes sandboxId and trafficAccessToken from the underlying sandbox', () => {
		const fake = makeFakeSandbox({
			sandboxId: 'sbx-exposed',
			trafficAccessToken: 'tok-exposed'
		});
		const session = wrapSandbox(fake as unknown as Sandbox);
		expect(session.sandboxId).toBe('sbx-exposed');
		expect(session.trafficAccessToken).toBe('tok-exposed');
	});
});
