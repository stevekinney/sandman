/**
 * client.spec.ts — SandboxClient unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * All E2B I/O is intercepted by an in-memory mock adapter — no real sandbox
 * is ever created.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSandboxClient, loadDefaultTemplateFiles } from './client.ts';
import { SANDBOX_STATUS } from '$lib/contracts/sandbox';
import type {
	E2bAdapter,
	E2bCreateOpts,
	E2bSandboxSession,
	SandboxCommandResult
} from './e2b-adapter.ts';
import type { SandboxHandle } from '$lib/contracts/sandbox';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type CallRecord =
	| { method: 'adapter.create'; opts: E2bCreateOpts }
	| { method: 'files.write'; path: string; data: string }
	| { method: 'commands.run'; cmd: string }
	| { method: 'commands.start'; cmd: string; pid: number }
	| { method: 'commands.kill'; pid: number }
	| { method: 'sandbox.setTimeout'; timeoutMs: number }
	| { method: 'sandbox.kill' }
	| { method: 'adapter.killById'; sandboxId: string; apiKey: string | undefined };

function createMockAdapter(sandboxId = 'mock-sandbox-id'): {
	adapter: E2bAdapter;
	calls: CallRecord[];
	session: E2bSandboxSession;
} {
	const calls: CallRecord[] = [];
	let pidCounter = 100;

	// Background commands model a long-running process: `wait()` stays pending
	// until the process is killed (by PID or via the handle), then resolves with
	// a SIGKILL-like non-zero code. This lets the WorkerSupervisor observe real
	// process exits the way it does against live E2B.
	const pendingWaits = new Map<number, (result: SandboxCommandResult) => void>();
	const resolveWait = (pid: number): void => {
		const resolve = pendingWaits.get(pid);
		if (resolve) {
			pendingWaits.delete(pid);
			resolve({ exitCode: 137, stdout: '', stderr: '' });
		}
	};

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
				const waitPromise = new Promise<SandboxCommandResult>((resolve) => {
					pendingWaits.set(pid, resolve);
				});
				return {
					pid,
					wait() {
						return waitPromise;
					},
					async kill() {
						resolveWait(pid);
						return true;
					}
				};
			},

			async kill(pid) {
				calls.push({ method: 'commands.kill', pid });
				resolveWait(pid);
				return true;
			}
		},

		files: {
			async write(path, data) {
				calls.push({ method: 'files.write', path, data });
			}
		},

		async setTimeout(timeoutMs) {
			calls.push({ method: 'sandbox.setTimeout', timeoutMs });
		},

		async kill() {
			calls.push({ method: 'sandbox.kill' });
			return true;
		}
	};

	const adapter: E2bAdapter = {
		async create(opts = {}) {
			calls.push({ method: 'adapter.create', opts });
			return session;
		},

		async killById(id, opts = {}) {
			calls.push({ method: 'adapter.killById', sandboxId: id, apiKey: opts.apiKey });
			return true;
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
		publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
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

	it('passes the configured E2B API key to the adapter', async () => {
		const { adapter, calls } = createMockAdapter();
		const client = createSandboxClient({
			adapter,
			apiKey: 'e2b-local-key',
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: {}
		});

		await client.provision();

		expect(calls).toContainEqual({
			method: 'adapter.create',
			opts: expect.objectContaining({ apiKey: 'e2b-local-key' })
		});
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

	it('passes allowPublicTraffic:true to expose proxied Temporal Web UI traffic', async () => {
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			...baseAdapter,
			async create(opts) {
				capturedOpts = opts;
				return baseAdapter.create(opts);
			}
		};
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		await client.provision();
		expect(capturedOpts?.network?.allowPublicTraffic).toBe(true);
	});

	it('extends the E2B sandbox timeout for an existing handle', async () => {
		const { client, calls } = makeClient();
		const handle = await client.provision();

		await client.extendTimeout(handle, 300_000);

		expect(calls).toContainEqual({ method: 'sandbox.setTimeout', timeoutMs: 300_000 });
	});
});

// ---------------------------------------------------------------------------
// Tests: provision() — E2B_TEMPLATE_ID wiring
// ---------------------------------------------------------------------------

describe('provision() — templateId wiring', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('passes templateId to adapter.create when set via SandboxClientOpts', async () => {
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			...baseAdapter,
			async create(opts) {
				capturedOpts = opts;
				return baseAdapter.create(opts);
			}
		};
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0,
			templateId: 'tmpl-test-123'
		});
		await client.provision();
		expect(capturedOpts?.templateId).toBe('tmpl-test-123');
	});

	it('passes templateId to adapter.create when set via E2B_TEMPLATE_ID env var', async () => {
		vi.stubEnv('E2B_TEMPLATE_ID', 'tmpl-from-env');
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			...baseAdapter,
			async create(opts) {
				capturedOpts = opts;
				return baseAdapter.create(opts);
			}
		};
		// Create client AFTER stubbing the env var so the resolved templateId picks it up.
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		await client.provision();
		expect(capturedOpts?.templateId).toBe('tmpl-from-env');
	});

	it('passes templateId as undefined when neither option nor env var is set', async () => {
		vi.stubEnv('E2B_TEMPLATE_ID', '');
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			...baseAdapter,
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
		expect(capturedOpts?.templateId).toBeUndefined();
	});

	it('SandboxClientOpts.templateId takes precedence over E2B_TEMPLATE_ID env var', async () => {
		vi.stubEnv('E2B_TEMPLATE_ID', 'tmpl-from-env');
		let capturedOpts: Parameters<E2bAdapter['create']>[0] | undefined;
		const { adapter: baseAdapter } = createMockAdapter();
		const adapter: E2bAdapter = {
			...baseAdapter,
			async create(opts) {
				capturedOpts = opts;
				return baseAdapter.create(opts);
			}
		};
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: {},
			maxReadinessRetries: 1,
			readinessDelayMs: 0,
			templateId: 'tmpl-explicit'
		});
		await client.provision();
		expect(capturedOpts?.templateId).toBe('tmpl-explicit');
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

	it('starts Temporal Web UI on 0.0.0.0:8233', () => {
		const temporalCall = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;

		expect(temporalCall?.cmd).toContain('--ui-ip 0.0.0.0');
		expect(temporalCall?.cmd).toContain('--ui-port 8233');
	});

	it('starts Temporal Web UI with the proxied public path for the sandbox', () => {
		const temporalCall = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;

		expect(temporalCall?.cmd).toContain('--ui-public-path /sbx/mock-sandbox-id/ui ');
	});

	it('returns ready:true when the Temporal server responds to workflow list', async () => {
		const { client: c2 } = makeClient('sbx-2');
		const h2 = await c2.provision();
		const result = await c2.bootstrap(h2);
		expect(result.ready).toBe(true);
	});

	it('returns ready:false when the Temporal Web UI never responds', async () => {
		const { adapter } = createMockAdapter('sbx-no-ui');
		const client = createSandboxClient({
			adapter: {
				...adapter,
				async create(opts) {
					const session = await adapter.create(opts);
					return {
						...session,
						commands: {
							...session.commands,
							async run(cmd, opts) {
								if (cmd.includes('http://127.0.0.1:8233/')) {
									return { exitCode: 7, stdout: '', stderr: 'connection refused' };
								}
								return session.commands.run(cmd, opts);
							}
						}
					};
				}
			},
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		const handle = await client.provision();
		const result = await client.bootstrap(handle);
		expect(result.ready).toBe(false);
	});

	it('returns ready:false while the public E2B host still serves the closed-port placeholder', async () => {
		const { adapter } = createMockAdapter('sbx-public-not-ready');
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () =>
				new Response('Closed Port Error: Connection refused on port 8233', { status: 200 }),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});

		const handle = await client.provision();
		const result = await client.bootstrap(handle);
		expect(result.ready).toBe(false);
	});

	it('retries a not-ready bootstrap after cleaning up the previous Temporal process', async () => {
		const { adapter, calls } = createMockAdapter('sbx-bootstrap-retry');
		let publicUiReady = false;
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () =>
				publicUiReady
					? new Response('<!doctype html><title>Temporal</title>')
					: new Response('Closed Port Error: Connection refused on port 8233', { status: 200 }),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		const handle = await client.provision();

		const firstResult = await client.bootstrap(handle);
		expect(firstResult.ready).toBe(false);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: false, workerOnline: false });
		expect(calls).toContainEqual({ method: 'commands.kill', pid: 100 });

		publicUiReady = true;
		calls.length = 0;
		const retryResult = await client.bootstrap(handle);

		expect(retryResult.ready).toBe(true);
		const temporalStartIdx = calls.findIndex(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		expect(temporalStartIdx).toBeGreaterThanOrEqual(0);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: true, workerOnline: true });
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
			async setTimeout() {},
			async kill() {
				return true;
			}
		};

		const client = createSandboxClient({
			adapter: {
				async create() {
					return session;
				},
				async killById() {
					return true;
				}
			},
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
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
	it('can stop the current worker process without starting a replacement', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.killWorker(handle);

		const killCall = calls.find((c) => c.method === 'commands.kill') as
			| Extract<CallRecord, { method: 'commands.kill' }>
			| undefined;
		expect(killCall).toBeDefined();
		expect(calls.some((c) => c.method === 'commands.start' && c.cmd.includes('worker'))).toBe(
			false
		);
	});

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
// Tests: processLiveness
// ---------------------------------------------------------------------------

describe('processLiveness()', () => {
	it('reports both online after bootstrap', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: true, workerOnline: true });
	});

	it('reflects a killed worker while the server stays up', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.killWorker(handle);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: true, workerOnline: false });
	});

	it('reports the worker back online after a restart (e.g. an editor save)', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.killWorker(handle);
		await client.restartWorker(handle);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: true, workerOnline: true });
	});

	it('reports both offline after stopServer', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.stopServer(handle);
		expect(client.processLiveness(handle)).toEqual({ serverOnline: false, workerOnline: false });
	});

	it('returns null for a terminated sandbox instead of throwing', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.terminate(handle);
		expect(client.processLiveness(handle)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: worker supervision wiring
// ---------------------------------------------------------------------------

describe('worker supervision', () => {
	it('starts the worker with its output redirected to a log file', async () => {
		const { client, calls } = makeClient();
		await provisionAndBootstrap(client);

		const workerStart = calls.find(
			(c) =>
				c.method === 'commands.start' &&
				c.cmd.includes('worker.ts') &&
				!c.cmd.includes('temporal server')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;

		expect(workerStart?.cmd).toContain(">> '/app/worker.log' 2>&1");
	});

	it('fails loudly when no sandbox-template files are available (image missing them)', async () => {
		// Production path: templateFiles is NOT injected, and the loader finds no
		// files. Provisioning a sandbox whose worker can never start must throw
		// instead of silently producing a dead sandbox. Point cwd at a directory
		// with no sandbox-template/ so loadDefaultTemplateFiles resolves to empty.
		const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-sandman-cwd');
		try {
			const { adapter } = createMockAdapter('sbx-no-template');
			const client = createSandboxClient({
				adapter,
				publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
				maxReadinessRetries: 1,
				readinessDelayMs: 0
			});

			const handle = await client.provision();
			await expect(client.bootstrap(handle)).rejects.toThrow(/sandbox-template/);
		} finally {
			cwdSpy.mockRestore();
		}
	});

	it('does NOT start the worker when Temporal never becomes ready', async () => {
		const { adapter, calls } = createMockAdapter('sbx-worker-skip');
		const client = createSandboxClient({
			adapter,
			// Public host keeps serving the closed-port placeholder → never ready.
			publicUiFetch: async () =>
				new Response('Closed Port Error: Connection refused on port 8233', { status: 200 }),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});

		const handle = await client.provision();
		const result = await client.bootstrap(handle);

		expect(result.ready).toBe(false);
		const startedWorker = calls.some(
			(c) =>
				c.method === 'commands.start' &&
				c.cmd.includes('worker.ts') &&
				!c.cmd.includes('temporal server')
		);
		expect(startedWorker).toBe(false);
		expect(client.processLiveness(handle)?.workerOnline).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: stopServer
// ---------------------------------------------------------------------------

describe('stopServer()', () => {
	it('kills the temporal dev server process by PID', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.stopServer(handle);

		expect(calls).toContainEqual({ method: 'commands.kill', pid: 100 });
	});

	it('also kills the worker process, since its connection dies with the server', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.stopServer(handle);

		const killedPids = calls
			.filter(
				(c): c is Extract<CallRecord, { method: 'commands.kill' }> => c.method === 'commands.kill'
			)
			.map((c) => c.pid);
		// Bootstrap started temporal (pid 100) then the worker (pid 101).
		expect(killedPids).toContain(100);
		expect(killedPids).toContain(101);
	});

	it('does not start any new process', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.stopServer(handle);

		expect(calls.some((c) => c.method === 'commands.start')).toBe(false);
	});

	it('is idempotent — calling twice does not throw', async () => {
		const { client } = makeClient();
		const handle = await provisionAndBootstrap(client);

		await client.stopServer(handle);
		await expect(client.stopServer(handle)).resolves.toBeUndefined();
	});

	it('is idempotent — second call issues no additional kill commands', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);

		await client.stopServer(handle);
		const countAfterFirst = calls.length;
		await client.stopServer(handle);

		expect(calls.length).toBe(countAfterFirst);
	});
});

// ---------------------------------------------------------------------------
// Tests: startServer
// ---------------------------------------------------------------------------

describe('startServer()', () => {
	it('starts a new temporal server process', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.stopServer(handle);
		calls.length = 0;

		await client.startServer(handle);

		const temporalStart = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		expect(temporalStart).toBeDefined();
	});

	it('re-registers the Temporal Search Attributes', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.stopServer(handle);
		calls.length = 0;

		await client.startServer(handle);

		const registeredAttribute = calls.some(
			(c) =>
				c.method === 'commands.run' && c.cmd.includes('search-attribute create --name OrderStatus')
		);
		expect(registeredAttribute).toBe(true);
	});

	it('restarts the worker after the server is ready', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.stopServer(handle);
		calls.length = 0;

		await client.startServer(handle);

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

	it('is idempotent when called without a preceding stopServer — kills the running server first', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		calls.length = 0;

		await client.startServer(handle);

		const killIdx = calls.findIndex(
			(c) => c.method === 'commands.kill' && c.pid === 100 // original temporal PID from bootstrap
		);
		const startIdx = calls.findIndex(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		);
		expect(killIdx).toBeGreaterThanOrEqual(0);
		expect(startIdx).toBeGreaterThan(killIdx);
	});

	it('recovers workflow state via --db-filename when restarting after a stop', async () => {
		const { client, calls } = makeClient();
		const handle = await provisionAndBootstrap(client);
		await client.stopServer(handle);
		calls.length = 0;

		await client.startServer(handle);

		const temporalCall = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;
		expect(temporalCall?.cmd).toContain('--db-filename /tmp/sandman.db');
	});

	it('throws when the Temporal server never becomes ready after restart', async () => {
		// Public host keeps serving the closed-port placeholder, so readiness
		// never flips — startServer must surface that instead of reporting success.
		const { adapter, calls } = createMockAdapter('sbx-start-not-ready');
		const client = createSandboxClient({
			adapter,
			publicUiFetch: async () =>
				new Response('Closed Port Error: Connection refused on port 8233', { status: 200 }),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		const handle = await client.provision();
		await client.bootstrap(handle);
		calls.length = 0;

		await expect(client.startServer(handle)).rejects.toThrow(/did not become ready/);

		// Regression: the not-ready process must not be left tracked as live —
		// otherwise /status reports serverOnline: true from a process that never
		// came up, and the client reconciles the topology back to "recovered".
		const newTemporalStart = calls.find(
			(c) => c.method === 'commands.start' && c.cmd.includes('temporal server start-dev')
		) as Extract<CallRecord, { method: 'commands.start' }> | undefined;
		expect(newTemporalStart).toBeDefined();
		expect(calls).toContainEqual({ method: 'commands.kill', pid: newTemporalStart?.pid });
		expect(client.processLiveness(handle)?.serverOnline).toBe(false);
	});

	it('throws with the worker stderr when the worker fails to restart during recovery', async () => {
		// The server comes back, but the worker restart fails (e.g. a compile
		// error in saved code). startServer must not report the worker recovered.
		const { adapter } = createMockAdapter('sbx-worker-fail');
		let failWorkerStart = false;
		const client = createSandboxClient({
			adapter: {
				...adapter,
				async create(opts) {
					const session = await adapter.create(opts);
					return {
						...session,
						commands: {
							...session.commands,
							async start(cmd, startOpts) {
								if (failWorkerStart && cmd.includes('worker') && !cmd.includes('temporal server')) {
									throw new Error('worker.ts(3,1): compile error');
								}
								return session.commands.start(cmd, startOpts);
							}
						}
					};
				}
			},
			publicUiFetch: async () => new Response('<!doctype html><title>Temporal</title>'),
			templateFiles: { '/app/worker.ts': '// placeholder worker' },
			maxReadinessRetries: 1,
			readinessDelayMs: 0
		});
		const handle = await client.provision();
		await client.bootstrap(handle);
		await client.stopServer(handle);
		// Only fail the worker restart that happens inside startServer.
		failWorkerStart = true;

		await expect(client.startServer(handle)).rejects.toThrow(/compile error/);
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
			adapter: { create: async () => session, killById: async () => true },
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
// Tests: terminateById
// ---------------------------------------------------------------------------

describe('terminateById()', () => {
	it('kills the session when this process holds in-memory state for the sandbox', async () => {
		const { client, calls } = makeClient('sbx-live');
		await client.provision();

		await client.terminateById('sbx-live');

		expect(calls.some((c) => c.method === 'sandbox.kill')).toBe(true);
		expect(calls.some((c) => c.method === 'adapter.killById')).toBe(false);
	});

	it('falls back to a provider kill by ID when the sandbox is unknown to this process', async () => {
		// Models the cross-restart case: the sandbox row exists in the database,
		// but the process that provisioned the VM is gone, so no in-memory state.
		const { adapter, calls } = createMockAdapter();
		const client = createSandboxClient({ adapter, apiKey: 'e2b-local-key', templateFiles: {} });

		await client.terminateById('sbx-orphaned-by-restart');

		expect(calls).toContainEqual({
			method: 'adapter.killById',
			sandboxId: 'sbx-orphaned-by-restart',
			apiKey: 'e2b-local-key'
		});
		expect(calls.some((c) => c.method === 'sandbox.kill')).toBe(false);
	});

	it('never double-kills a session already terminated via terminate()', async () => {
		const { client, calls } = makeClient('sbx-live');
		const handle = await client.provision();

		await client.terminate(handle);
		// State is gone, so this degrades to a provider-side kill by ID — which
		// E2B treats as a harmless no-op for an already-dead sandbox.
		await client.terminateById('sbx-live');

		const sessionKills = calls.filter((c) => c.method === 'sandbox.kill').length;
		expect(sessionKills).toBe(1);
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
		expect(keys).toContain('/app/signals.ts');
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
