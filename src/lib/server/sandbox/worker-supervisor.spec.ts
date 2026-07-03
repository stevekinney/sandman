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

function createFakeSession(logTail = 'worker crash log', options: { deferRun?: boolean } = {}) {
	const startCommands: string[] = [];
	const startTimeouts: Array<number | undefined> = [];
	const runCommands: string[] = [];
	const killedPids: number[] = [];
	const handles: FakeHandle[] = [];
	// When deferRun is set, each commands.run (the log tail) stays pending until
	// the test calls resolveNextRun(), so a stop/restart can be interleaved.
	const pendingRuns: Array<() => void> = [];
	const resolveNextRun = (): void => pendingRuns.shift()?.();
	let startShouldThrow: (() => boolean) | undefined;
	const setStartThrows = (predicate: () => boolean): void => {
		startShouldThrow = predicate;
	};
	let pidCounter = 1;

	const session: E2bSandboxSession = {
		sandboxId: 'fake-sandbox',
		trafficAccessToken: undefined,
		getHost: () => '',
		commands: {
			async run(cmd) {
				runCommands.push(cmd);
				if (options.deferRun) {
					await new Promise<void>((resolve) => pendingRuns.push(resolve));
				}
				return { exitCode: 0, stdout: logTail, stderr: '' };
			},
			async start(cmd, opts) {
				if (startShouldThrow?.()) {
					throw new Error('worker.ts(3,1): spawn failure');
				}
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

	return {
		session,
		startCommands,
		startTimeouts,
		runCommands,
		killedPids,
		handles,
		resolveNextRun,
		setStartThrows
	};
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
			"cd /app && node_modules/.bin/tsx worker.ts >> '/app/worker.log' 2>&1"
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

	it('reports and retries when a scheduled auto-restart fails to spawn', async () => {
		const { session, startCommands, handles, setStartThrows } = createFakeSession();
		const scheduler = createManualScheduler();
		const onCrash = vi.fn();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, onCrash, maxRestarts: 3 })
		);

		await supervisor.start(); // handle 0
		handles[0].exit(1); // crash → schedules restart
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		expect(onCrash).toHaveBeenCalledTimes(1);

		// The scheduled restart's spawn throws: it must be reported as a crash and
		// another restart scheduled (budget remains), not silently swallowed.
		setStartThrows(() => true);
		scheduler.fire();
		await vi.waitFor(() => expect(onCrash).toHaveBeenCalledTimes(2));
		expect(supervisor.online).toBe(false);
		expect(scheduler.hasPending()).toBe(true);

		// Recovery once spawning works again.
		setStartThrows(() => false);
		scheduler.fire();
		await vi.waitFor(() => expect(supervisor.online).toBe(true));
		expect(startCommands.length).toBeGreaterThanOrEqual(2);
	});

	it('does not restart or report a crash when stopped during the crash-log read', async () => {
		const { session, startCommands, handles, resolveNextRun } = createFakeSession('log', {
			deferRun: true
		});
		const scheduler = createManualScheduler();
		const onCrash = vi.fn();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, onCrash })
		);

		await supervisor.start(); // handle 0
		handles[0].exit(1); // crash → onExit awaits the (deferred) log read
		await vi.waitFor(() => expect(supervisor.online).toBe(false));

		// While the log read is in flight, the operator restarts deliberately.
		await supervisor.stop();
		resolveNextRun(); // now let the stale log read resolve
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The stale handler must not fire onCrash or schedule a restart.
		expect(onCrash).not.toHaveBeenCalled();
		expect(scheduler.hasPending()).toBe(false);
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
		await vi.waitFor(() => expect(supervisor.online).toBe(false));
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));

		scheduler.fire(); // restart 2 (handle 2)
		await vi.waitFor(() => expect(startCommands).toHaveLength(3));
		handles[2].exit(1); // third crash — budget exhausted
		await vi.waitFor(() => expect(supervisor.online).toBe(false));

		expect(scheduler.hasPending()).toBe(false); // no further restart scheduled
		expect(startCommands).toHaveLength(3);
	});

	it('resets the crash budget after an auto-restarted worker stays stable', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, maxRestarts: 1 })
		);

		await supervisor.start(); // handle 0
		handles[0].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		scheduler.fire(); // restart 1 (handle 1) and schedule the stability reset
		await vi.waitFor(() => expect(startCommands).toHaveLength(2));

		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		scheduler.fire(); // stability window elapsed
		handles[1].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));

		scheduler.fire(); // budget was reset, so another restart is allowed
		await vi.waitFor(() => expect(startCommands).toHaveLength(3));
		expect(supervisor.online).toBe(true);
	});

	it('does not reset the crash budget when the restarted worker crashes before stability', async () => {
		const { session, startCommands, handles } = createFakeSession();
		const scheduler = createManualScheduler();
		const supervisor = new WorkerSupervisor(
			baseOptions(session, { schedule: scheduler.schedule, maxRestarts: 1 })
		);

		await supervisor.start(); // handle 0
		handles[0].exit(1);
		await vi.waitFor(() => expect(scheduler.hasPending()).toBe(true));
		scheduler.fire(); // restart 1 (handle 1) and schedule the stability reset
		await vi.waitFor(() => expect(startCommands).toHaveLength(2));

		handles[1].exit(1); // crash before the stability reset fires
		await vi.waitFor(() => expect(supervisor.online).toBe(false));

		expect(scheduler.hasPending()).toBe(false);
		expect(startCommands).toHaveLength(2);
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

	it('keeps the worker reported online until kill confirms it stopped', async () => {
		const { session } = createFakeSession();
		let resolveKill!: () => void;
		const killStarted = vi.fn();
		session.commands.kill = async () => {
			killStarted();
			await new Promise<void>((resolve) => {
				resolveKill = resolve;
			});
			return true;
		};
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await supervisor.start();
		const pid = supervisor.pid;
		const stopPromise = supervisor.stop();

		await vi.waitFor(() => expect(killStarted).toHaveBeenCalledTimes(1));
		expect(supervisor.pid).toBe(pid);
		expect(supervisor.online).toBe(true);

		resolveKill();
		await stopPromise;

		expect(supervisor.pid).toBeUndefined();
		expect(supervisor.online).toBe(false);
	});

	it('preserves worker state and surfaces the error when kill fails', async () => {
		const { session } = createFakeSession();
		session.commands.kill = async () => {
			throw new Error('kill failed');
		};
		const supervisor = new WorkerSupervisor(baseOptions(session));

		await supervisor.start();
		const pid = supervisor.pid;

		await expect(supervisor.stop()).rejects.toThrow(/kill failed/);
		expect(supervisor.pid).toBe(pid);
		expect(supervisor.online).toBe(true);
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
