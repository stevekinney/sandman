/**
 * worker-supervisor.ts — keeps the in-sandbox Temporal worker alive and honest.
 *
 * The worker runs inside the E2B VM as an unsupervised background process. If it
 * crashes on startup (or mid-flight) there is nothing in the VM to bring it back,
 * and the previous liveness signal — "a PID was assigned" — stayed `true` forever,
 * so the UI showed a green worker while the task queue had zero pollers and every
 * workflow hung.
 *
 * This supervisor fixes that failure class from the host side, where the E2B
 * command handle's `wait()` tells us when the process *actually* exits:
 *
 *   - `online` reflects real liveness (set on a successful start, cleared the
 *     moment the process exits or is stopped) — never mere PID presence.
 *   - An *unexpected* crash (non-zero exit that we did not initiate) triggers an
 *     automatic restart, up to `maxRestarts` consecutive attempts, so a transient
 *     startup failure self-heals.
 *   - A *deliberate* stop (`stop()`, used by the "kill the worker" tour step and
 *     by server stop) never auto-restarts — the worker stays down until an
 *     explicit `restart()`, preserving the durable-recovery demo.
 *   - Every crash reads the tail of the worker log (the process's stdout+stderr,
 *     which the run command appends to `logPath`) and reports it via `onCrash`,
 *     so the reason a worker died is finally visible instead of discarded.
 */

import type { E2bSandboxSession, SandboxCommandHandle } from './e2b-adapter.ts';

/** Details of an unexpected worker exit, surfaced through `onCrash`. */
export type WorkerCrash = {
	/** Process exit code (non-zero for a crash). */
	exitCode: number;
	/** Epoch milliseconds when the exit was observed. */
	at: number;
	/** Tail of the worker's combined stdout+stderr log at crash time. */
	log: string;
};

/** Construction options for {@link WorkerSupervisor}. */
export type WorkerSupervisorOptions = {
	/** Live sandbox session used to start/kill the worker process. */
	session: E2bSandboxSession;
	/**
	 * Worker command WITHOUT output redirection, e.g.
	 * `cd /app && node_modules/.bin/tsx worker.ts`. The supervisor appends the
	 * append-to-log redirection itself.
	 */
	command: string;
	/** Absolute path inside the sandbox for the worker's combined output log. */
	logPath: string;
	/**
	 * E2B command timeout, in milliseconds — the maximum lifetime E2B allows the
	 * background worker process before killing it (E2B's own default is only 60s,
	 * far shorter than a demo session). Set this to the sandbox lifetime so the
	 * worker lives as long as the VM. Defaults to 300000.
	 */
	commandTimeoutMs?: number;
	/**
	 * Maximum consecutive auto-restarts after an unexpected crash before giving
	 * up (a runaway crash-loop backstop). An explicit {@link stop}/{@link restart},
	 * or an auto-restarted worker that survives {@link stabilityWindowMs}, resets
	 * the counter. Defaults to 3.
	 */
	maxRestarts?: number;
	/** Delay before an auto-restart, in milliseconds. Defaults to 2000. */
	restartDelayMs?: number;
	/**
	 * How long an auto-restarted worker must stay online before its crash budget
	 * is considered stable and reset. Defaults to 30000.
	 */
	stabilityWindowMs?: number;
	/**
	 * Timer used to schedule auto-restarts. Returns a canceller. Injectable so
	 * tests can drive restarts synchronously. Defaults to `setTimeout`.
	 */
	schedule?: (run: () => void, delayMs: number) => () => void;
	/**
	 * Invoked when the worker exits unexpectedly, before any auto-restart.
	 * Wire this to a server logger so worker crashes are diagnosable in
	 * production logs instead of being silently swallowed inside the VM.
	 */
	onCrash?: (crash: WorkerCrash) => void;
};

/** Single-quote a value for safe interpolation into a POSIX shell command. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 2_000;
const DEFAULT_STABILITY_WINDOW_MS = 30_000;
/**
 * Default worker command lifetime. E2B kills a background command after its
 * `timeoutMs` (default 60s); the worker must outlive that, so we default to 5
 * minutes and callers pass the actual sandbox lifetime.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
	const timer = setTimeout(run, delayMs);
	// Do not keep the Node event loop alive purely for a pending restart.
	timer.unref?.();
	return () => clearTimeout(timer);
};

/**
 * Supervises a single in-sandbox worker process. One instance per sandbox.
 * All process I/O goes through the injected {@link E2bSandboxSession}, so this
 * is fully unit-testable with a mock session.
 */
export class WorkerSupervisor {
	readonly #session: E2bSandboxSession;
	readonly #command: string;
	readonly #logPath: string;
	readonly #commandTimeoutMs: number;
	readonly #maxRestarts: number;
	readonly #restartDelayMs: number;
	readonly #stabilityWindowMs: number;
	readonly #schedule: (run: () => void, delayMs: number) => () => void;
	readonly #onCrash: ((crash: WorkerCrash) => void) | undefined;

	#pid: number | undefined;
	#online = false;
	#disposed = false;
	#restarts = 0;
	/**
	 * Monotonic counter identifying the current worker process. Every start/stop
	 * bumps it; a watcher only acts on its exit if its generation is still
	 * current. This is what makes a deliberate kill race-free: the killed
	 * process's `wait()` resolves after the replacement has started, but its
	 * (now stale) generation means its exit is ignored rather than mistaken for a
	 * crash of the new process.
	 */
	#generation = 0;
	#cancelPending: (() => void) | undefined;
	#cancelStabilityReset: (() => void) | undefined;
	#stopInFlight: { pid: number; generation: number } | undefined;
	#lastCrash: WorkerCrash | undefined;

	constructor(options: WorkerSupervisorOptions) {
		this.#session = options.session;
		this.#command = options.command;
		this.#logPath = options.logPath;
		this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.#maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
		this.#restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
		this.#stabilityWindowMs = options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
		this.#schedule = options.schedule ?? defaultSchedule;
		this.#onCrash = options.onCrash;
	}

	/** True while the worker process is running (real liveness, not PID presence). */
	get online(): boolean {
		return this.#online;
	}

	/** PID of the current worker process, or undefined when not running. */
	get pid(): number | undefined {
		return this.#pid;
	}

	/** The most recent unexpected exit, or undefined if the worker never crashed. */
	get lastCrash(): WorkerCrash | undefined {
		return this.#lastCrash;
	}

	/** Worker command with stdout+stderr appended to the log file. */
	get #runCommand(): string {
		return `${this.#command} >> ${shellQuote(this.#logPath)} 2>&1`;
	}

	/**
	 * Starts the worker process and begins watching it for crashes. Propagates a
	 * spawn failure (e.g. a compile error surfaced synchronously) so explicit
	 * callers can surface a compile error; the auto-restart path handles spawn
	 * failures itself.
	 */
	async start(): Promise<void> {
		if (this.#disposed) return;
		this.#clearPending();
		this.#clearStabilityReset();
		const generation = ++this.#generation;
		await this.#spawn(generation, true, false);
	}

	/**
	 * Stops the worker deliberately: it will NOT auto-restart until an explicit
	 * {@link start}/{@link restart}. Resets the crash budget. Safe to call when
	 * the worker is already stopped.
	 */
	async stop(): Promise<void> {
		const pid = this.#pid;
		if (pid === undefined) {
			this.#generation++;
			this.#clearPending();
			this.#clearStabilityReset();
			this.#online = false;
			this.#restarts = 0;
			return;
		}

		const stopGeneration = this.#generation;
		this.#stopInFlight = { pid, generation: stopGeneration };
		this.#clearPending();
		try {
			await this.#session.commands.kill(pid);
		} catch (err) {
			if (this.#isStopInFlight(pid, stopGeneration)) {
				this.#stopInFlight = undefined;
			}
			throw err;
		}
		if (this.#isStopInFlight(pid, stopGeneration) && this.#pid === pid) {
			this.#generation++;
			this.#stopInFlight = undefined;
			this.#clearStabilityReset();
			this.#restarts = 0;
			this.#online = false;
			this.#pid = undefined;
		}
	}

	/**
	 * Explicit restart (editor hot-reload, server recovery): stop the current
	 * process, then start a fresh one. Resets the crash budget. Propagates a
	 * spawn failure so callers can surface a compile error.
	 */
	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	/** Permanently stops supervision when the sandbox is terminated. */
	dispose(): void {
		this.#disposed = true;
		this.#generation++;
		this.#clearPending();
		this.#clearStabilityReset();
		this.#stopInFlight = undefined;
		this.#online = false;
		this.#pid = undefined;
	}

	#clearPending(): void {
		this.#cancelPending?.();
		this.#cancelPending = undefined;
	}

	#clearStabilityReset(): void {
		this.#cancelStabilityReset?.();
		this.#cancelStabilityReset = undefined;
	}

	#isStopInFlight(pid: number, generation: number): boolean {
		return this.#stopInFlight?.pid === pid && this.#stopInFlight.generation === generation;
	}

	/**
	 * Spawns the worker process for the given generation and watches it. When
	 * `propagate` is true a spawn failure is rethrown (explicit start/restart);
	 * otherwise it is treated as a crash and retried within budget (auto-restart).
	 */
	async #spawn(
		generation: number,
		propagate: boolean,
		resetBudgetAfterStable: boolean
	): Promise<void> {
		let handle: SandboxCommandHandle;
		try {
			handle = await this.#session.commands.start(this.#runCommand, {
				timeoutMs: this.#commandTimeoutMs
			});
		} catch (err) {
			if (propagate) throw err;
			this.#handleCrash(generation, 1, err instanceof Error ? err.message : String(err));
			return;
		}

		// A competing stop()/dispose()/newer start() moved on while the spawn was
		// in flight — this handle is already stale. Kill it so we neither clobber
		// the current worker nor leak a process.
		if (this.#disposed || generation !== this.#generation) {
			void this.#session.commands.kill(handle.pid).catch(() => {});
			return;
		}

		this.#pid = handle.pid;
		this.#online = true;
		if (resetBudgetAfterStable) {
			this.#scheduleStabilityReset(generation);
		}
		void this.#observeExit(handle, generation);
	}

	#scheduleStabilityReset(generation: number): void {
		this.#clearStabilityReset();
		this.#cancelStabilityReset = this.#schedule(() => {
			this.#cancelStabilityReset = undefined;
			if (this.#disposed || generation !== this.#generation || !this.#online) return;
			this.#restarts = 0;
		}, this.#stabilityWindowMs);
	}

	/**
	 * Awaits the process exit and routes it to {@link #onExit}. Guaranteed not to
	 * reject: a rejected wait() (transport error or a killed process) is treated
	 * as a non-clean exit, and any error from the exit handling is swallowed so a
	 * misbehaving crash reporter can never surface as an unhandled rejection.
	 */
	async #observeExit(handle: SandboxCommandHandle, generation: number): Promise<void> {
		let exitCode: number;
		try {
			exitCode = (await handle.wait()).exitCode;
		} catch {
			exitCode = 1;
		}
		try {
			await this.#onExit(exitCode, generation);
		} catch {
			// #onExit must not throw; this is a last-resort safety net.
		}
	}

	async #onExit(exitCode: number, generation: number): Promise<void> {
		// A stale generation means this exit belongs to a process we already
		// replaced or deliberately stopped — ignore it entirely.
		if (this.#disposed || generation !== this.#generation) return;
		if (this.#pid !== undefined && this.#isStopInFlight(this.#pid, generation)) {
			this.#generation++;
			this.#stopInFlight = undefined;
			this.#clearStabilityReset();
			this.#restarts = 0;
			this.#online = false;
			this.#pid = undefined;
			return;
		}
		this.#clearStabilityReset();
		this.#online = false;
		this.#pid = undefined;

		// A clean exit (code 0) is a graceful shutdown, not a crash — do not
		// restart. The real worker exits non-zero on fatal errors.
		if (exitCode === 0) return;

		const log = await this.#readLogTail();
		// The tail read is async; a manual stop()/restart()/dispose() may have
		// bumped the generation meanwhile. Re-check before reporting the crash or
		// scheduling a restart so we neither consume budget nor clobber a newer
		// worker with a stale handler.
		if (this.#disposed || generation !== this.#generation) return;

		this.#handleCrash(generation, exitCode, log);
	}

	/**
	 * Records a crash, reports it, and schedules an auto-restart when budget
	 * remains. Callers guarantee the generation is current.
	 */
	#handleCrash(generation: number, exitCode: number, log: string): void {
		if (this.#disposed || generation !== this.#generation) return;
		this.#clearStabilityReset();
		this.#online = false;
		this.#pid = undefined;

		const crash: WorkerCrash = { exitCode, at: Date.now(), log };
		this.#lastCrash = crash;
		try {
			this.#onCrash?.(crash);
		} catch {
			// A misbehaving reporter must not break supervision.
		}

		// Runaway crash-loop backstop: give up loudly (the crash was reported).
		if (this.#restarts >= this.#maxRestarts) return;
		this.#restarts += 1;
		this.#cancelPending = this.#schedule(() => {
			if (this.#disposed) return;
			this.#clearPending();
			const nextGeneration = ++this.#generation;
			void this.#spawn(nextGeneration, false, true);
		}, this.#restartDelayMs);
	}

	async #readLogTail(): Promise<string> {
		try {
			const result = await this.#session.commands.run(
				`tail -n 80 ${shellQuote(this.#logPath)} 2>/dev/null`,
				{ timeoutMs: 10_000 }
			);
			return `${result.stdout}${result.stderr}`.trim();
		} catch {
			return '';
		}
	}
}
