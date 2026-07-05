/**
 * client.ts — SandboxClient implementation backed by E2B.
 *
 * Call `createSandboxClient(opts)` to get a `SandboxClient`.  Pass a mock
 * `E2bAdapter` to unit-test lifecycle logic without hitting real E2B APIs.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type {
	SandboxClient,
	SandboxHandle,
	WorkerStatus,
	ProcessLiveness,
	ExecResult
} from '$lib/contracts/sandbox';
import { SANDBOX_STATUS } from '$lib/contracts/sandbox';
import type { E2bAdapter, E2bSandboxSession } from './e2b-adapter.ts';
import { createRealE2bAdapter } from './e2b-adapter.ts';
import { WorkerSupervisor } from './worker-supervisor.ts';
import type { WorkerCrash } from './worker-supervisor.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** gRPC frontend port for the Temporal dev server. */
const TEMPORAL_GRPC_PORT = 7233;

/** Web UI port for the Temporal dev server. */
const TEMPORAL_UI_PORT = 8233;

/**
 * Command that starts the Temporal dev server inside the sandbox.
 * Must bind to 0.0.0.0 so it is reachable from outside the VM.
 */
function getTemporalServerCommand(sandboxId: string): string {
	return (
		'temporal server start-dev ' +
		'--ip 0.0.0.0 ' +
		'--port 7233 ' +
		'--ui-ip 0.0.0.0 ' +
		'--ui-port 8233 ' +
		`--ui-public-path /sbx/${sandboxId}/ui ` +
		'--db-filename /tmp/sandman.db'
	);
}

/** Command used to run the TypeScript worker inside the sandbox. */
const WORKER_CMD = 'cd /app && node_modules/.bin/tsx worker.ts';

/**
 * File inside the sandbox that the worker's combined stdout+stderr is appended
 * to, so a crashing worker leaves a readable log instead of vanishing silently.
 */
const WORKER_LOG_PATH = '/app/worker.log';

/** Command used to install sandbox dependencies. */
const INSTALL_CMD = 'cd /app && npm install --prefer-offline';

/**
 * Installs the Temporal CLI inside the sandbox when the base image lacks it.
 * The official installer drops the binary in `~/.temporalio/bin`, which is not on
 * the non-interactive PATH, so we symlink it into `/usr/local/bin` (writable and
 * on PATH in the E2B base image). Baking the CLI into a prebuilt E2B template
 * would remove this per-boot download — tracked as a perf follow-up.
 */
const TEMPORAL_INSTALL_CMD =
	'curl -sSf https://temporal.download/cli.sh | sh && ' +
	'ln -sf "$HOME/.temporalio/bin/temporal" /usr/local/bin/temporal';

/** How many times to poll before declaring temporal not ready. */
const DEFAULT_READINESS_RETRIES = 60;

/** Milliseconds between readiness probes in production. */
const DEFAULT_READINESS_DELAY_MS = 2_000;

/** Default sandbox lifetime (10 minutes). */
const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type InternalSandboxState = {
	session: E2bSandboxSession;
	worker: WorkerSupervisor | undefined;
	temporalPid: number | undefined;
	bootstrapped: boolean;
	terminated: boolean;
	createdAt: number;
};

/**
 * Logs a worker crash so it is visible in server logs. The worker runs inside
 * the sandbox with no other place to surface a fatal error, so without this the
 * reason a worker died (a compile error, a bad import, a failed connection) was
 * lost entirely.
 */
function reportWorkerCrash(sandboxId: string, crash: WorkerCrash): void {
	console.error(
		`[sandman] Sandbox ${sandboxId} worker exited unexpectedly (code ${crash.exitCode}). ` +
			`Recent worker log:\n${crash.log || '(worker log was empty)'}`
	);
}

/** Options for `createSandboxClient`. */
export type SandboxClientOpts = {
	/** E2B adapter to use. Defaults to the real adapter. */
	adapter?: E2bAdapter;
	/** API key passed directly to the E2B SDK. */
	apiKey?: string;
	/** Fetch implementation used to probe the public E2B Web UI host. */
	publicUiFetch?: typeof fetch;
	/**
	 * Pre-loaded files to write into every sandbox during bootstrap.
	 * If omitted, files are read from `sandbox-template/` at runtime.
	 * Pass an empty record to skip file writing (useful in tests that don't
	 * need to exercise file content).
	 */
	templateFiles?: Record<string, string>;
	/** Sandbox VM timeout in milliseconds. */
	sandboxTimeoutMs?: number;
	/** Maximum number of times to probe gRPC port before giving up. */
	maxReadinessRetries?: number;
	/** Milliseconds to wait between readiness probes. */
	readinessDelayMs?: number;
	/** Max consecutive worker auto-restarts after a crash. Test hook; defaults to the supervisor's own default. */
	workerMaxRestarts?: number;
	/** Delay before a worker auto-restart, in ms. Test hook; defaults to the supervisor's own default. */
	workerRestartDelayMs?: number;
	/** Timer used to schedule worker auto-restarts. Test hook for synchronous restarts. */
	workerSchedule?: (run: () => void, delayMs: number) => () => void;
	/**
	 * ID of a prebuilt E2B template to use when provisioning sandboxes.
	 * Falls back to `process.env.E2B_TEMPLATE_ID` when unset here.
	 * If neither is set, the E2B default base image is used and the Temporal
	 * CLI plus worker deps are installed on demand during bootstrap.
	 */
	templateId?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Patterns whose matching files are excluded from sandbox VM writes. */
const EXCLUDED_TEMPLATE_PATTERNS: ReadonlyArray<RegExp> = [
	/\.test\.ts$/,
	/\.spec\.ts$/,
	/^vitest\.config\./
];

/**
 * Loads runtime `.ts` and `.json` files from `sandbox-template/` into a record
 * keyed by their `/app/<name>` destination path inside the sandbox VM.
 *
 * Test files (`*.test.ts`, `*.spec.ts`) and config files (`vitest.config.*`)
 * are excluded — they have no role at runtime and should not be shipped into
 * the sandbox.
 *
 * @internal Exported for unit testing; external callers should prefer
 *   `SandboxClientOpts.templateFiles` to supply pre-loaded content.
 */
export async function loadDefaultTemplateFiles(): Promise<Record<string, string>> {
	const templateDir = join(process.cwd(), 'sandbox-template');
	const allowedExtensions = new Set(['.ts', '.json']);
	const files: Record<string, string> = {};

	let entries: string[];
	try {
		entries = await readdir(templateDir);
	} catch {
		// Directory not present yet (before Track D runs) — skip gracefully.
		return files;
	}

	await Promise.all(
		entries
			.filter(
				(name) =>
					allowedExtensions.has(extname(name)) &&
					!EXCLUDED_TEMPLATE_PATTERNS.some((pattern) => pattern.test(name))
			)
			.map(async (name) => {
				const contents = await readFile(join(templateDir, name), 'utf-8');
				files[`/app/${name}`] = contents;
			})
	);

	return files;
}

/**
 * Ensures Node.js and the Temporal CLI are available in the sandbox.
 *
 * Node.js ships in the E2B base image, so a missing `node` fails loudly. The
 * Temporal CLI is NOT in the base image: when it is absent we install it on
 * demand (download + symlink onto PATH) and re-verify, rather than failing.
 * Baking both tools into a prebuilt E2B template would remove the per-boot
 * install latency — tracked as a perf follow-up.
 */
async function ensureRuntimeDependencies(session: E2bSandboxSession): Promise<void> {
	const nodeResult = await session.commands.run('node --version', { timeoutMs: 10_000 });
	if (nodeResult.exitCode !== 0) {
		throw new Error(
			`Node.js is not installed in the sandbox environment. ` +
				`Use an E2B template that includes Node.js. stderr: ${nodeResult.stderr}`
		);
	}

	const temporalResult = await session.commands.run('temporal --version', { timeoutMs: 10_000 });
	if (temporalResult.exitCode === 0) return;

	// Not in the base template — install it (the "otherwise install" path).
	const install = await session.commands.run(TEMPORAL_INSTALL_CMD, { timeoutMs: 180_000 });
	if (install.exitCode !== 0) {
		throw new Error(`Failed to install the Temporal CLI in the sandbox. stderr: ${install.stderr}`);
	}

	const verify = await session.commands.run('temporal --version', { timeoutMs: 10_000 });
	if (verify.exitCode !== 0) {
		throw new Error(`Temporal CLI is not runnable after install. stderr: ${verify.stderr}`);
	}
}

/**
 * Polls the Temporal dev server until it accepts commands.
 * Uses `temporal workflow list` as the readiness probe.
 */
async function waitForTemporal(
	session: E2bSandboxSession,
	maxRetries: number,
	delayMs: number
): Promise<boolean> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const result = await session.commands.run('temporal workflow list', { timeoutMs: 5_000 });
		if (result.exitCode === 0) return true;
		if (delayMs > 0 && attempt < maxRetries - 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

async function registerSearchAttributes(session: E2bSandboxSession): Promise<void> {
	for (const name of ['OrderStatus', 'CustomerTier', 'RestaurantId']) {
		const result = await session.commands.run(
			`temporal operator search-attribute create --name ${name} --type Keyword`,
			{ timeoutMs: 10_000 }
		);
		const output = `${result.stdout}${result.stderr}`.toLowerCase();
		if (result.exitCode !== 0 && !output.includes('already')) {
			throw new Error(`Failed to register Temporal Search Attribute ${name}: ${result.stderr}`);
		}
	}
}

/**
 * Polls the Temporal Web UI until it responds inside the sandbox.
 * A sandbox is not user-ready unless both the gRPC API and Web UI are up.
 */
async function waitForTemporalUi(
	session: E2bSandboxSession,
	maxRetries: number,
	delayMs: number
): Promise<boolean> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const result = await session.commands.run(
			`curl -fsS http://127.0.0.1:${TEMPORAL_UI_PORT}/ >/dev/null`,
			{ timeoutMs: 5_000 }
		);
		if (result.exitCode === 0) return true;
		if (delayMs > 0 && attempt < maxRetries - 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

/**
 * Polls the public E2B host until the same URL the iframe uses serves the
 * Temporal UI instead of E2B's transient closed-port placeholder.
 */
async function waitForPublicTemporalUi(
	uiUrl: string,
	accessToken: string,
	publicUiFetch: typeof fetch,
	maxRetries: number,
	delayMs: number
): Promise<boolean> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const headers = new Headers();
			if (accessToken.length > 0) headers.set('e2b-traffic-access-token', accessToken);
			const response = await publicUiFetch(uiUrl, { cache: 'no-store', headers });
			const text = await response.text();
			if (
				response.ok &&
				!text.includes('Closed Port Error') &&
				!text.includes('Connection refused')
			) {
				return true;
			}
		} catch {
			// Keep polling until the E2B public proxy can reach the sandbox port.
		}
		if (delayMs > 0 && attempt < maxRetries - 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

/**
 * Waits for a freshly (re)started Temporal dev server to become fully
 * reachable — gRPC (7233), the local Web UI (8233), and the same public E2B
 * host the iframe uses — then registers the custom Search Attributes a
 * fresh server process always starts without.
 *
 * Shared by `bootstrap` and `startServer`, which both start the same
 * `temporal server start-dev` process and must wait on it identically.
 */
async function waitForTemporalReady(
	session: E2bSandboxSession,
	handle: SandboxHandle,
	publicUiFetch: typeof fetch,
	maxRetries: number,
	delayMs: number
): Promise<{ ready: boolean; uiUrl: string }> {
	const temporalReady = await waitForTemporal(session, maxRetries, delayMs);
	const localTemporalUiReady = temporalReady
		? await waitForTemporalUi(session, maxRetries, delayMs)
		: false;
	const uiUrl = handle.host(TEMPORAL_UI_PORT);
	const publicTemporalUiReady = localTemporalUiReady
		? await waitForPublicTemporalUi(uiUrl, handle.accessToken, publicUiFetch, maxRetries, delayMs)
		: false;
	const ready = temporalReady && localTemporalUiReady && publicTemporalUiReady;

	if (temporalReady) {
		await registerSearchAttributes(session);
	}

	return { ready, uiUrl };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `SandboxClient` that manages E2B Firecracker MicroVM sandboxes.
 *
 * Inject a mock `E2bAdapter` and/or pre-loaded `templateFiles` for unit tests.
 */
export function createSandboxClient(opts: SandboxClientOpts = {}): SandboxClient {
	const {
		adapter = createRealE2bAdapter(),
		apiKey,
		publicUiFetch = fetch,
		sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
		maxReadinessRetries = DEFAULT_READINESS_RETRIES,
		readinessDelayMs = DEFAULT_READINESS_DELAY_MS
	} = opts;

	// Resolve the template ID: explicit option wins, then env var, then undefined
	// (empty-string env var is treated as unset so Sandbox.create is never called
	// with an empty string as the template name).
	const templateId: string | undefined =
		opts.templateId ?? (process.env.E2B_TEMPLATE_ID || undefined);

	const sandboxes = new Map<string, InternalSandboxState>();

	/**
	 * Builds a worker supervisor for a sandbox. The supervisor owns the worker
	 * process lifecycle: real liveness, crash auto-restart, and log capture.
	 * Test hooks (`workerMaxRestarts`, `workerRestartDelayMs`, `workerSchedule`)
	 * are threaded through when provided.
	 */
	function createWorkerSupervisor(session: E2bSandboxSession, sandboxId: string): WorkerSupervisor {
		return new WorkerSupervisor({
			session,
			command: WORKER_CMD,
			logPath: WORKER_LOG_PATH,
			// Let E2B keep the worker alive for the sandbox's whole lifetime rather
			// than its 60s command default (which would kill the worker mid-demo).
			commandTimeoutMs: sandboxTimeoutMs,
			maxRestarts: opts.workerMaxRestarts,
			restartDelayMs: opts.workerRestartDelayMs,
			schedule: opts.workerSchedule,
			onCrash: (crash) => reportWorkerCrash(sandboxId, crash)
		});
	}

	// ------------------------------------------------------------------
	// provision
	// ------------------------------------------------------------------

	async function provision(provisionOpts?: { timeoutMs?: number }): Promise<SandboxHandle> {
		const session = await adapter.create({
			apiKey,
			timeoutMs: provisionOpts?.timeoutMs ?? sandboxTimeoutMs,
			network: { allowPublicTraffic: true },
			templateId
		});

		const state: InternalSandboxState = {
			session,
			worker: undefined,
			temporalPid: undefined,
			bootstrapped: false,
			terminated: false,
			createdAt: Date.now()
		};
		sandboxes.set(session.sandboxId, state);

		return {
			id: session.sandboxId,
			status: SANDBOX_STATUS.Provisioning,
			host: (port) => session.getHost(port),
			accessToken: session.trafficAccessToken ?? ''
		};
	}

	// ------------------------------------------------------------------
	// bootstrap
	// ------------------------------------------------------------------

	async function bootstrap(handle: SandboxHandle): Promise<{ ready: boolean; uiUrl: string }> {
		const state = getState(handle.id);
		const { session } = state;

		if (state.bootstrapped) {
			// Idempotent — already done for this sandbox.
			return { ready: true, uiUrl: handle.host(TEMPORAL_UI_PORT) };
		}

		if (state.temporalPid !== undefined) {
			await session.commands.kill(state.temporalPid);
			state.temporalPid = undefined;
		}

		// 0. Verify Node.js and Temporal CLI are available in the sandbox image.
		await ensureRuntimeDependencies(session);

		// 1. Determine files to write.
		const files =
			opts.templateFiles !== undefined ? opts.templateFiles : await loadDefaultTemplateFiles();

		// A production sandbox with no worker sources is dead on arrival —
		// `tsx worker.ts` crash-loops with ERR_MODULE_NOT_FOUND. This happens when
		// `sandbox-template/` is missing from the deployed image, which
		// loadDefaultTemplateFiles otherwise swallows. Fail loudly at the boundary
		// instead of provisioning a sandbox whose worker can never start. (Tests
		// may pass an explicit empty `templateFiles` to skip file writing.)
		if (opts.templateFiles === undefined && Object.keys(files).length === 0) {
			throw new Error(
				'No sandbox-template files found on the server. The deployed image is missing ' +
					'the sandbox-template/ directory, so the worker cannot start.'
			);
		}

		// 2. Write template files into the sandbox.
		for (const [path, contents] of Object.entries(files)) {
			await session.files.write(path, contents);
		}

		// 3. Install dependencies.
		await session.commands.run(INSTALL_CMD, { timeoutMs: 120_000 });

		// 4. Start the Temporal dev server in the background.
		const temporalHandle = await session.commands.start(getTemporalServerCommand(handle.id), {
			timeoutMs: 300_000
		});
		state.temporalPid = temporalHandle.pid;

		// 5. Wait for gRPC (7233) and the Web UI (8233) to be reachable, then
		//    register custom Search Attributes before workflows can upsert them.
		const { ready, uiUrl } = await waitForTemporalReady(
			session,
			handle,
			publicUiFetch,
			maxReadinessRetries,
			readinessDelayMs
		);

		if (!ready) {
			await session.commands.kill(temporalHandle.pid);
			state.temporalPid = undefined;
			return { ready, uiUrl };
		}

		// 6. Start the worker under a supervisor that keeps it alive (auto-restart
		//    on crash), reports honest liveness, and captures its log.
		state.worker = createWorkerSupervisor(session, handle.id);
		await state.worker.start();
		state.bootstrapped = true;

		return { ready, uiUrl };
	}

	// ------------------------------------------------------------------
	// restartWorker
	// ------------------------------------------------------------------

	async function killWorker(handle: SandboxHandle): Promise<void> {
		const state = getState(handle.id);
		// A deliberate stop — the supervisor will NOT auto-restart, so the worker
		// stays down until restartWorker (the durable-recovery demo depends on it).
		await state.worker?.stop();
	}

	async function restartWorker(handle: SandboxHandle): Promise<WorkerStatus> {
		const state = getState(handle.id);
		state.worker ??= createWorkerSupervisor(state.session, handle.id);

		// Restart ONLY the worker; the Temporal server keeps running.
		try {
			await state.worker.restart();
			return { ok: true, phase: 'restarting' };
		} catch (err) {
			const stderr = err instanceof Error ? err.message : String(err);
			return { ok: false, phase: 'compile-error', stderr };
		}
	}

	// ------------------------------------------------------------------
	// stopServer / startServer
	// ------------------------------------------------------------------

	async function stopServer(handle: SandboxHandle): Promise<void> {
		const state = getState(handle.id);

		// The worker's `Worker.run()` throws a fatal error the moment its gRPC
		// connection to the Temporal server dies (see @temporalio/worker). Stop
		// the worker deliberately BEFORE killing the server so its supervisor
		// treats the exit as intentional and does not thrash trying to restart
		// it against a server that is going away. startServer restarts it once
		// the new server is ready.
		await killWorker(handle);

		if (state.temporalPid !== undefined) {
			await state.session.commands.kill(state.temporalPid);
			state.temporalPid = undefined;
		}
	}

	async function startServer(handle: SandboxHandle): Promise<void> {
		const state = getState(handle.id);
		const { session } = state;

		// Idempotent — kill any existing temporal process before starting a new one.
		if (state.temporalPid !== undefined) {
			await session.commands.kill(state.temporalPid);
			state.temporalPid = undefined;
		}

		const temporalHandle = await session.commands.start(getTemporalServerCommand(handle.id), {
			timeoutMs: 300_000
		});
		state.temporalPid = temporalHandle.pid;

		const readiness = await waitForTemporalReady(
			session,
			handle,
			publicUiFetch,
			maxReadinessRetries,
			readinessDelayMs
		);
		// Mirror bootstrap: a server that never becomes reachable is a failure,
		// not a silent success — otherwise the UI marks the server recovered
		// while gRPC/Web UI are still down and later controls fail. Clear the
		// tracked PID before throwing so `processLiveness` (polled by /status)
		// doesn't report the server online from a process that never came up.
		if (!readiness.ready) {
			await session.commands.kill(temporalHandle.pid);
			state.temporalPid = undefined;
			throw new Error('Temporal server did not become ready after restart.');
		}

		// The worker's connection died with the old server process; restart it
		// against the new one. Surface a failed restart (e.g. a compile error in
		// saved code) instead of reporting the worker recovered when it is not.
		const workerStatus = await restartWorker(handle);
		if (!workerStatus.ok) {
			throw new Error(workerStatus.stderr ?? 'Worker failed to restart after server recovery.');
		}
	}

	// ------------------------------------------------------------------
	// exec
	// ------------------------------------------------------------------

	async function exec(
		handle: SandboxHandle,
		command: string,
		execOpts?: { timeoutMs?: number }
	): Promise<ExecResult> {
		const { session } = getState(handle.id);
		return session.commands.run(command, { timeoutMs: execOpts?.timeoutMs });
	}

	// ------------------------------------------------------------------
	// extendTimeout
	// ------------------------------------------------------------------

	async function extendTimeout(handle: SandboxHandle, timeoutMs: number): Promise<void> {
		const { session } = getState(handle.id);
		await session.setTimeout(timeoutMs);
	}

	// ------------------------------------------------------------------
	// writeFile
	// ------------------------------------------------------------------

	async function writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void> {
		const { session } = getState(handle.id);
		await session.files.write(path, contents);
	}

	// ------------------------------------------------------------------
	// terminate
	// ------------------------------------------------------------------

	async function terminate(handle: SandboxHandle): Promise<void> {
		const state = sandboxes.get(handle.id);
		if (!state || state.terminated) {
			// Idempotent — safe to call twice.
			return;
		}
		state.terminated = true;
		// Stop supervising the worker so a pending auto-restart can't fire against
		// a torn-down sandbox.
		state.worker?.dispose();
		sandboxes.delete(handle.id);
		await state.session.kill();
	}

	// ------------------------------------------------------------------
	// terminateById
	// ------------------------------------------------------------------

	async function terminateById(sandboxId: string): Promise<void> {
		const state = sandboxes.get(sandboxId);
		if (state) {
			if (state.terminated) return;
			state.terminated = true;
			state.worker?.dispose();
			sandboxes.delete(sandboxId);
			await state.session.kill();
			return;
		}
		// No in-memory state — the sandbox was provisioned by a previous server
		// process. Kill it at the provider by ID; E2B resolves false (not an
		// error) when the sandbox is already gone.
		await adapter.killById(sandboxId, { apiKey });
	}

	// ------------------------------------------------------------------
	// Internal helpers
	// ------------------------------------------------------------------

	function getState(id: string): InternalSandboxState {
		const state = sandboxes.get(id);
		if (!state) throw new Error(`Sandbox not found: ${id}`);
		if (state.terminated) throw new Error(`Sandbox has already been terminated: ${id}`);
		return state;
	}

	/**
	 * Process liveness for the /status endpoint. The server signal is the tracked
	 * PID; the worker signal is the supervisor's real liveness — the worker
	 * process is actually running, not merely that a PID was assigned at spawn
	 * time (a crashed worker used to report online forever, masking a dead demo).
	 * Reads the state map directly (not `getState`, which throws) so it returns
	 * `null` for an unknown/terminated sandbox instead of taking /status down.
	 */
	function processLiveness(handle: SandboxHandle): ProcessLiveness | null {
		const state = sandboxes.get(handle.id);
		if (!state || state.terminated) return null;
		return {
			serverOnline: state.temporalPid !== undefined,
			workerOnline: state.worker?.online ?? false
		};
	}

	return {
		provision,
		bootstrap,
		restartWorker,
		killWorker,
		stopServer,
		startServer,
		processLiveness,
		exec,
		extendTimeout,
		writeFile,
		terminate,
		terminateById
	};
}

// Re-export the port constants so other modules can reference them.
export { TEMPORAL_GRPC_PORT, TEMPORAL_UI_PORT };
