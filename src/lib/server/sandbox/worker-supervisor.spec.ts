/**
 * worker-supervisor.spec.ts — WorkerSupervisor unit tests.
 *
 * Runs in the "server" vitest project (node environment). A fake session lets
 * each test drive process exits (clean, crash, deliberate kill) deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkerSupervisor } from './worker-supervisor.ts';
import type { E2bSandboxSession, SandboxCommandResult } from './e2b-adapter.ts';

// ---------------------------------------------------------------------------
// Fake session
// ---------------------------------------------------------------------------

type FakeHandle = {
	pid: number;
	wait(): Promise<SandboxCommandResult>;
	kill(): Promise<boolean>;
	/** Test-only: resolve this handle's wait() with the given exit code. */
	exit(code: number): void;
};

function createFakeSession(logTail = 'worker crash log') {
	const startCommands: string[] = [];
	const startTimeouts: Array<number | undefined> = [];
	const runCommands: string[] = [];
	const killedPids: number[] = [];
	const handles: FakeHandle[] = [];
	let pidCounter = 1;

	const session: E2bSandboxSession = {
		sandboxId: 'fake-sandbox',
		trafficAccessToken: undefined,
		getHost: () => '',
		commands: {
			async run(cmd) {
				runCommands.push(cmd);
				return { exitCode: 0, stdout: logTail, stderr: '' };
			},
			async start(cmd, opts) {
				startCommands.push(cmd);
				startTimeouts.push(opts?.timeoutMs);
				const pid = pidCounter++;
				let resolveWait!: (result: SandboxCommandResult) => void;
				const waitPromise = new Promise<SandboxCommandResult>((resolve) => {
					resolveWait = resolve;
				});
				const handle: FakeHandle = {
					pid,
					wait: () => waitPromise,
					kill: async () => {
						resolveWait({ exitCode: 137, stdout: '', stderr: '' });
						return true;
					},
					exit: (code) => resolveWait({ exitCode: code, stdout: '', stderr: '' })
				};
				handles.push(handle);
				return handle;
			},
			async kill(pid) {
				killedPids.push(pid);
				handles.find((h) => h.pid === pid)?.exit(137);
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

	return { session, startCommands, startTimeouts, runCommands, killedPids, handles };
}

/** A manual scheduler: captures the pending restart so a test can fire it. */
function createManualScheduler() {
	let pending: (() => void) | null = null;
	const schedule = (run: () => void): (() => void) => {
		pending = run;
		return () => {
			pending = null;
		};
	};
	return {
		schedule,
		hasPending: () => pending !== null,
		fire: () => {
			const run = pending;
			pending = null;
			run?.();
		}
	};
}

const baseOptions = (session: E2bSandboxSession, overrides = {}) => ({
	session,
	command: 'cd /app && node_modules/.bin/tsx worker.ts',
	logPath: '/app/worker.log',
	...overrides
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerSupervisor.start()', () => {
	it('starts the worker and reports online', async () => {
		const { session, startCommands } = createFakeSession();
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await supervisor.start();

		expect(supervisor.online).toBe(true);
		expect(startCommands).toHaveLength(1);
	});

	it('appends worker stdout+stderr to the log file', async () => {
		const { session, startCommands } = createFakeSession();
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await supervisor.start();

		expect(startCommands[0]).toBe(
			'cd /app && node_modules/.bin/tsx worker.ts >> /app/worker.log 2>&1'
		);
	});

	it('launches the worker with the configured command timeout, not E2Bs 60s default', async () => {
		const { session, startTimeouts } = createFakeSession();
		const supervisor = new WorkerSupervisor(baseOptions(session, { commandTimeoutMs: 600_000 }));

		await supervisor.start();

		expect(startTimeouts[0]).toBe(600_000);
	});
});

describe('WorkerSupervisor crash recovery', () => {
	it('auto-restarts the worker after an unexpected crash', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(baseOptions(session, { schedule: scheduler.schedule }));

		await supervisor.start();
		handles[0].exit(1); // crash

		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		expect(supervisor.online).toBe(false);

		scheduler.fire(); // fire the scheduled restart
		await vi.waitFor(() => expect(supervisor.online).toBe(true));
		expect(startCommands).toHaveLength(2);
	});

	it('reports the crash with the tail of the worker log', async () => {
		const { session, handles } = createFakeSession('Error: bad import in activities.ts');
		const scheduler = createManualScheduler();
		const onCrash = vi.fn();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, onCrash })
		);

		await supervisor.start();
		handles[0].exit(1);

		await vi.waitFor(() => expect(onCrash).toHaveBeenCalledTimes(1));
		expect(onCrash.mock.calls[0][0]).toMatchObject({
			exitCode: 1,
			log: 'Error: bad import in activities.ts'
		});
	});

	it('does NOT restart after a clean (exit 0) shutdown', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const onCrash = vi.fn();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, onCrash })
		);

		await supervisor.start();
		handles[0].exit(0); // graceful shutdown

		await vi.waitFor(() => expect(supervisor.online).toBe(false));
		expect(scheduler.hasPending()).toBe(false);
		expect(onCrash).not.toHaveBeenCalled();
		expect(startCommands).toHaveLength(1);
	});

	it('gives up after maxRestarts consecutive crashes', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, maxRestarts: 2 })
		);

		await supervisor.start(); // attempt 0 (handle 0)
		handles[0].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));

		scheduler.fire(); // restart 1 (handle 1)
		await vi.waitFor(() => expect(startCommands).toHaveLength(2));
		handles[1].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));

		scheduler.fire(); // restart 2 (handle 2)
		await vi.waitFor(() => expect(startCommands).toHaveLength(3));
		handles[2].exit(1); // third crash — budget exhausted
		await vi.waitFor(() => expect(supervisor.online).toBe(false));

		expect(scheduler.hasPending()).toBe(false); // no further restart scheduled
		expect(startCommands).toHaveLength(3);
	});
});

describe('WorkerSupervisor.stop()', () => {
	it('kills the worker by PID and does not auto-restart', async () => {
		const { session, startCommands, killedPids } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(baseOptions(session, { schedule: scheduler.schedule }));

		await supervisor.start();
		const pid = supervisor.pid;
		await supervisor.stop();

		expect(killedPids).toEqual([pid]);
		expect(supervisor.online).toBe(false);
		// The kill resolves wait(), but a deliberate stop must not restart.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(scheduler.hasPending()).toBe(false);
		expect(startCommands).toHaveLength(1);
	});

	it('is safe to call when the worker is already stopped', async () => {
		const { session } = createFakeSession();
		const supervisor = new WorkerSupervisor(baseOptions(session));
		await expect(supervisor.stop()).resolves.toBeUndefined();
	});
});

describe('WorkerSupervisor.restart()', () => {
	it('stops the current worker then starts a fresh one', async () => {
		const { session, startCommands, killedPids } = createFakeSession();
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await supervisor.start();
		const firstPid = supervisor.pid;
		await supervisor.restart();

		expect(killedPids).toContain(firstPid);
		expect(startCommands).toHaveLength(2);
		expect(supervisor.online).toBe(true);
	});

	it('resets the crash budget so a later crash can auto-restart again', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, maxRestarts: 1 })
		);

		await supervisor.start(); // handle 0
		handles[0].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		scheduler.fire(); // budget used (restart 1) — handle 1
		await vi.waitFor(() => expect(startCommands).toHaveLength(2));

		await supervisor.restart(); // explicit restart resets the budget — handle 2
		await vi.waitFor(() => expect(startCommands).toHaveLength(3));
		handles[2].exit(1); // crash again — budget available once more
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
	});

	it('surfaces a spawn failure so callers can report a compile error', async () => {
		const { session } = createFakeSession();
		session.commands.start = async () => {
			throw new Error('worker.ts(3,1): compile error');
		};
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await expect(supervisor.restart()).rejects.toThrow(/compile error/);
		expect(supervisor.online).toBe(false);
	});
});

describe('WorkerSupervisor.dispose()', () => {
	it('stops supervising so a pending restart never fires', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(baseOptions(session, { schedule: scheduler.schedule }));

		await supervisor.start();
		handles[0].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));

		supervisor.dispose();
		scheduler.fire(); // pending restart, if any, must be a no-op

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(supervisor.online).toBe(false);
		expect(startCommands).toHaveLength(1);
	});
});
