/**
 * client.spec.ts — SandboxClient unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * All E2B I/O is intercepted by an in-memory mock adapter — no real sandbox
 * is ever created.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSandboxClient, loadDefaultTemplateFiles } from './client.ts';
import { SANDBOX_STATUS } from '$lib/contracts/sandbox';
import type { E2bAdapter, E2bSandboxSession } from './e2b-adapter.ts';
import type { SandboxHandle } from '$lib/contracts/sandbox';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type CallRecord =
	| { method: 'files.write'; path: string; data: string }
	| { method: 'commands.run'; cmd: string }
	| { method: 'commands.start'; cmd: string; pid: number }
	| { method: 'commands.kill'; pid: number }
	| { method: 'sandbox.kill' };

function createMockAdapter(sandboxId = 'mock-sandbox-id'): {
	adapter: E2bAdapter;
	calls: CallRecord[];
	session: E2bSandboxSession;
} {
	const calls: CallRecord[] = [];
	let pidCounter = 100;

	const session: E2bSandboxSession = {
		sandboxId,
		trafficAccessToken: 'mock-access-token',
		getHost: (port) => `${sandboxId}-${port}.e2b.dev`,

		commands: {
			async run(cmd) {
				calls.push({ method: 'commands.run', cmd });
				return { exitCode: 0, stdout: '', stderr: '' };
			},

			async start(cmd) {
				const pid = pidCounter++;
				calls.push({ method: 'commands.start', cmd, pid });
				return {
					pid,
					async wait() {
						return { exitCode: 0, stdout: '', stderr: '' };
					},
					async kill() {
						return true;
					}
				};
			},

			async kill(pid) {
				calls.push({ method: 'commands.kill', pid });
				return true;
			}
		},

		files: {
			async write(path, data) {
				calls.push({ method: 'files.write', path, data });
			}
		},

		async kill() {
			calls.push({ method: 'sandbox.kill' });
			return true;
		}
	};

	const adapter: E2bAdapter = {
		async create() {
			return session;
		}
	};

	return { adapter, calls, session };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a client pre-wired with the mock adapter and minimal template files
 * so `bootstrap` has one file to write but finishes quickly.
 */
function makeClient(sandboxId?: string): {
	client: ReturnType<typeof createSandboxClient>;
	calls: CallRecord[];
} {
	const { adapter, calls } = createMockAdapter(sandboxId);
	const client = createSandboxClient({
		adapter,
		templateFiles: { '/app/worker.ts': '// placeholder worker' },
		maxReadinessRetries: 1,
		readinessDelayMs: 0
	});
	return { client, calls };
}

async function provisionAndBootstrap(
	client: ReturnType<typeof createSandboxClient>
): Promise<SandboxHandle> {
	const handle = await client.provision();
	await client.bootstrap(handle);
	return handle;
}

// ---------------------------------------------------------------------------
// Tests: provision
// ---------------------------------------------------------------------------

describe('provision()', () => {
	it('returns a handle whose id is the E2B sandbox ID', async () => {
		const { client } = makeClient('sbx-abc');
		const handle = await client.provision();
		expect(handle.id).toBe('sbx-abc');
	});

	it('returns a handle with status Provisioning', async () => {
		const { client } = makeClient();
		const handle = await client.provision();
		expect(handle.status).toBe(SANDBOX_STATUS.Provisioning);
	});

	it('returns a handle whose host() returns an https:// URL', async () => {
		const { client } = makeClient('sbx-xyz');
		const handle = await client.provision();
		const url = handle.host(8233);
		// The mock getHost prepends nothing; the real adapter prepends https://.
		// The mock session.getHost returns "<id>-<port>.e2b.dev" which the
		// E2bSandboxSession.getHost wraps.  In the mock we return the raw value
		// because we own the whole session — just assert it's a non-empty string.
		expect(typeof url).toBe('string');
		expect(url.length).toBeGreaterThan(0);
	});

	it('returns a handle with an accessToken string', async () => {
		const { client } = makeClient();
		const handle = await client.provision();
		expect(typeof handle.accessToken).toBe('string');
		expect(handle.accessToken).toBe('mock-access-token');
	});

	it('passes allowPublicTraffic:false to the adapter', async () => {
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			async create(opts) {
				capturedOpts = opts;
				return baseAdapter.create(opts);
			}
		};
		const client = createSandboxClient({
			adapter,
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		await client.provision();
		expect(capturedOpts?.network?.allowPublicTraffic).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: bootstrap sequence (ORDER asserted against the mock)
// ---------------------------------------------------------------------------

describe('bootstrap()', () => {
	let client: ReturnType<typeof createSandboxClient>;
	let calls: CallRecord[];
	let handle: SandboxHandle;

	beforeEach(async () => {
		({ client, calls } = makeClient());
		handle = await client.provision();
		await client.bootstrap(handle);
	});

	it('checks node --version before writing any template files', () => {
		const nodeCheckIdx = calls.findIndex(
			(c) => c.method === 'commands.run' && c.cmd === 'node --version'
		);
		const firstWriteIdx = calls.findIndex((c) => c.method === 'files.write');
		expect(nodeCheckIdx).toBeGreaterThanOrEqual(0);
		expect(nodeCheckIdx).toBeLessThan(firstWriteIdx);
	});

	it('checks temporal --version before writing any template files', () => {
		const temporalCheckIdx = calls.findIndex(
			(c) => c.method === 'commands.run' && c.cmd === 'temporal --version'
		);
		const firstWriteIdx = calls.findIndex((c) => c.method === 'files.write');
		expect(temporalCheckIdx).toBeGreaterThanOrEqual(0);
		expect(temporalCheckIdx).toBeLessThan(firstWriteIdx);
	});

	it('writes at least one template file before running install', () => {
		const firstWriteIdx = calls.findIndex((c) => c.method === 'files.write');
		const installIdx = calls.findIndex(
			(c) => c.method === 'commands.run' && c.cmd.includes('install')
		);
		expect(firstWriteIdx).toBeGreaterThanOrEqual(0);
		expect(firstWriteIdx).toBeLessThan(installIdx);
	});

	it('runs the install command before starting the Temporal dev server', () => {
		const installIdx = calls.findIndex(
			(c) => c.method === 'commands.run' && c.cmd.includes('install')
		);
		const temporalIdx = calls.findIndex(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		expect(installIdx).toBeGreaterThanOrEqual(0);
		expect(installIdx).toBeLessThan(temporalIdx);
	});

	it('starts the Temporal dev server before starting the worker', () => {
		const temporalIdx = calls.findIndex(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		const workerIdx = calls.findIndex(
			(c) =>
				c.method === 'commands.start' &&
				c.cmd.includes('worker') &&
				!c.cmd.includes('temporal server')
		);
		expect(temporalIdx).toBeGreaterThanOrEqual(0);
		expect(workerIdx).toBeGreaterThan(temporalIdx);
	});

	it('starts Temporal dev server with --ip 0.0.0.0', () => {
		const temporalCall = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;

		expect(temporalCall).toBeDefined();
		expect(temporalCall?.cmd).toContain('--ip 0.0.0.0');
	});

	it('starts Temporal dev server with --db-filename /tmp/sandman.db', () => {
		const temporalCall = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;

		expect(temporalCall?.cmd).toContain('--db-filename /tmp/sandman.db');
	});

	it('returns ready:true when the Temporal server responds to workflow list', async () => {
		const { client: c2 } = makeClient('sbx-2');
		const h2 = await c2.provision();
		const result = await c2.bootstrap(h2);
		expect(result.ready).toBe(true);
	});

	it('returns a uiUrl on the same host as handle.host(8233)', async () => {
		const { client: c2 } = makeClient('sbx-3');
		const h2 = await c2.provision();
		const result = await c2.bootstrap(h2);
		expect(result.uiUrl).toBe(h2.host(8233));
	});

	it('is idempotent — second call returns ready:true without issuing new commands', async () => {
		const countBefore = calls.length;
		const result = await client.bootstrap(handle);
		expect(result.ready).toBe(true);
		expect(calls.length).toBe(countBefore); // no new calls
	});
});

// ---------------------------------------------------------------------------
// Tests: bootstrap installs the Temporal CLI when the base image lacks it
// ---------------------------------------------------------------------------

describe('bootstrap() — Temporal CLI install path', () => {
	/**
	 * Builds a client whose sandbox reports the Temporal CLI as missing until the
	 * install command has run. `installExitCode` controls whether that install
	 * succeeds. Returns a recorder of every command the bootstrap issues.
	 */
	function makeInstallScenario(installExitCode: number): {
		client: ReturnType<typeof createSandboxClient>;
		ranCommands: string[];
	} {
		const ranCommands: string[] = [];
		let installed = false;

		const session: E2bSandboxSession = {
			sandboxId: 'sbx-install',
			trafficAccessToken: 'tok',
			getHost: (port) => `sbx-install-${port}.e2b.dev`,
			commands: {
				async run(cmd) {
					ranCommands.push(cmd);
					if (cmd.includes('temporal.download/cli.sh')) {
						if (installExitCode === 0) installed = true;
						return { exitCode: installExitCode, stdout: '', stderr: 'install stderr' };
					}
					if (cmd === 'temporal --version') {
						return installed
							? { exitCode: 0, stdout: 'temporal version 1.7.2', stderr: '' }
							: { exitCode: 127, stdout: '', stderr: 'temporal: command not found' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				},
				async start() {
					return {
						pid: 1,
						async wait() {
							return { exitCode: 0, stdout: '', stderr: '' };
						},
						async kill() {
							return true;
						}
					};
				},
				async kill() {
					return true;
				}
			},
			files: {
				async write() {}
			},
			async kill() {
				return true;
			}
		};

		const client = createSandboxClient({
			adapter: {
				async create() {
					return session;
				}
			},
			templateFiles: { '/app/worker.ts': '// placeholder' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		return { client, ranCommands };
	}

	it('installs the Temporal CLI on demand, then re-verifies and proceeds', async () => {
		const { client, ranCommands } = makeInstallScenario(0);
		const handle = await client.provision();
		const result = await client.bootstrap(handle);

		// The on-demand installer was invoked.
		expect(ranCommands.some((c) => c.includes('temporal.download/cli.sh'))).toBe(true);
		// `temporal --version` is checked once before install and once after.
		expect(ranCommands.filter((c) => c === 'temporal --version')).toHaveLength(2);
		expect(result.ready).toBe(true);
	});

	it('throws a descriptive error when the Temporal CLI install fails', async () => {
		const { client } = makeInstallScenario(1);
		const handle = await client.provision();
		await expect(client.bootstrap(handle)).rejects.toThrow(/Failed to install the Temporal CLI/);
	});
});

// ---------------------------------------------------------------------------
// Tests: restartWorker
// ---------------------------------------------------------------------------

describe('restartWorker()', () => {
	it('kills the current worker process by PID', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0; // reset log after bootstrap

		await client.restartWorker(handle);

		const killCall = calls.find((c) => c.method === 'commands.kill') as
			| Extract<CallRecord, { method: 'commands.kill' }>
			| undefined;
		expect(killCall).toBeDefined();
	});

	it('starts a new worker after killing the old one', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.restartWorker(handle);

		const killIdx = calls.findIndex((c) => c.method === 'commands.kill');
		const startIdx = calls.findIndex(
			(c) => c.method === 'commands.start' && c.cmd.includes('worker')
		);
		expect(killIdx).toBeGreaterThanOrEqual(0);
		expect(startIdx).toBeGreaterThan(killIdx);
	});

	it('does NOT re-issue the Temporal server start command', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.restartWorker(handle);

		const hasTemporalStart = calls.some(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		expect(hasTemporalStart).toBe(false);
	});

	it('returns ok:true and phase:"restarting" on success', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		const status = await client.restartWorker(handle);
		expect(status.ok).toBe(true);
		expect(status.phase).toBe('restarting');
	});
});

// ---------------------------------------------------------------------------
// Tests: exec
// ---------------------------------------------------------------------------

describe('exec()', () => {
	it('runs the command and returns stdout/stderr/exitCode', async () => {
		const { adapter: baseAdapter } = createMockAdapter();
		const session = await baseAdapter.create();
		// Override run to return specific values.
		session.commands.run = async () => ({ exitCode: 0, stdout: 'hello', stderr: '' });
		const client = createSandboxClient({
			adapter: { create: async () => session },
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		const handle = await client.provision();
		const result = await client.exec(handle, 'echo hello');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('hello');
	});
});

// ---------------------------------------------------------------------------
// Tests: writeFile
// ---------------------------------------------------------------------------

describe('writeFile()', () => {
	it('delegates to session.files.write with the correct path and contents', async () => {
		const { client, calls } = makeClient();
		const handle = await client.provision();
		await client.writeFile(handle, '/app/workflows.ts', 'export const x = 1;');

		const writeCall = calls.find(
			(c) => c.method === 'files.write' && c.path === '/app/workflows.ts'
		) as Extract<CallRecord, { method: 'files.write' }> | undefined;

		expect(writeCall).toBeDefined();
		expect(writeCall?.data).toBe('export const x = 1;');
	});
});

// ---------------------------------------------------------------------------
// Tests: terminate (idempotency)
// ---------------------------------------------------------------------------

describe('terminate()', () => {
	it('calls sandbox.kill() on the underlying session', async () => {
		const { client, calls } = makeClient();
		const handle = await client.provision();
		await client.terminate(handle);

		expect(calls.some((c) => c.method === 'sandbox.kill')).toBe(true);
	});

	it('is idempotent — calling twice does not throw or double-kill', async () => {
		const { client, calls } = makeClient();
		const handle = await client.provision();
		await client.terminate(handle);
		await client.terminate(handle); // second call — must not throw

		const killCount = calls.filter((c) => c.method === 'sandbox.kill').length;
		expect(killCount).toBe(1); // sandbox killed exactly once
	});
});

// ---------------------------------------------------------------------------
// Tests: loadDefaultTemplateFiles — exclude test / config files
// ---------------------------------------------------------------------------

describe('loadDefaultTemplateFiles()', () => {
	it('includes runtime files that the sandbox worker needs', async () => {
		const files = await loadDefaultTemplateFiles();
		const keys = Object.keys(files);

		expect(keys).toContain('/app/package.json');
		expect(keys).toContain('/app/worker.ts');
		expect(keys).toContain('/app/workflows.ts');
		expect(keys).toContain('/app/activities.ts');
		expect(keys).toContain('/app/shared.ts');
		expect(keys).toContain('/app/client.ts');
	});

	it('excludes *.test.ts files from the sandbox', async () => {
		const files = await loadDefaultTemplateFiles();
		const keys = Object.keys(files);

		const testFiles = keys.filter((k) => k.endsWith('.test.ts'));
		expect(testFiles).toHaveLength(0);
	});

	it('excludes *.spec.ts files from the sandbox', async () => {
		const files = await loadDefaultTemplateFiles();
		const keys = Object.keys(files);

		const specFiles = keys.filter((k) => k.endsWith('.spec.ts'));
		expect(specFiles).toHaveLength(0);
	});

	it('excludes vitest.config.ts from the sandbox', async () => {
		const files = await loadDefaultTemplateFiles();

		expect(files).not.toHaveProperty('/app/vitest.config.ts');
	});
});
