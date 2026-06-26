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
	ExecResult
} from '$lib/contracts/sandbox';
import { SANDBOX_STATUS } from '$lib/contracts/sandbox';
import type { E2bAdapter, E2bSandboxSession } from './e2b-adapter.ts';
import { createRealE2bAdapter } from './e2b-adapter.ts';

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
const TEMPORAL_SERVER_CMD = 'temporal server start-dev --ip 0.0.0.0 --db-filename /tmp/sandman.db';

/** Command used to run the TypeScript worker inside the sandbox. */
const WORKER_CMD = 'cd /app && node_modules/.bin/tsx worker.ts';

/** Command used to install sandbox dependencies. */
const INSTALL_CMD = 'cd /app && npm install --prefer-offline';

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
	workerPid: number | undefined;
	temporalPid: number | undefined;
	bootstrapped: boolean;
	terminated: boolean;
	createdAt: number;
};

/** Options for `createSandboxClient`. */
export type SandboxClientOpts = {
	/** E2B adapter to use. Defaults to the real adapter. */
	adapter?: E2bAdapter;
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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loads all `.ts` and `.json` files from `sandbox-template/`. */
async function loadDefaultTemplateFiles(): Promise<Record<string, string>> {
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
			.filter((name) => allowedExtensions.has(extname(name)))
			.map(async (name) => {
				const contents = await readFile(join(templateDir, name), 'utf-8');
				files[`/app/${name}`] = contents;
			})
	);

	return files;
}

/**
 * Verifies that Node.js and the Temporal CLI are present in the sandbox.
 * Throws a descriptive error if either binary is missing, so callers get a
 * clear failure message instead of a cryptic `temporal server start-dev` exit.
 *
 * Use an E2B template that pre-installs both tools. Creating that template is
 * tracked as a followup task.
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
	if (temporalResult.exitCode !== 0) {
		throw new Error(
			`Temporal CLI is not installed in the sandbox environment. ` +
				`Use an E2B template that includes the Temporal CLI. stderr: ${temporalResult.stderr}`
		);
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
		sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
		maxReadinessRetries = DEFAULT_READINESS_RETRIES,
		readinessDelayMs = DEFAULT_READINESS_DELAY_MS
	} = opts;

	const sandboxes = new Map<string, InternalSandboxState>();

	// ------------------------------------------------------------------
	// provision
	// ------------------------------------------------------------------

	async function provision(provisionOpts?: { timeoutMs?: number }): Promise<SandboxHandle> {
		const session = await adapter.create({
			timeoutMs: provisionOpts?.timeoutMs ?? sandboxTimeoutMs,
			network: { allowPublicTraffic: false }
		});

		const state: InternalSandboxState = {
			session,
			workerPid: undefined,
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

		// 0. Verify Node.js and Temporal CLI are available in the sandbox image.
		await ensureRuntimeDependencies(session);

		// 1. Determine files to write.
		const files =
			opts.templateFiles !== undefined ? opts.templateFiles : await loadDefaultTemplateFiles();

		// 2. Write template files into the sandbox.
		for (const [path, contents] of Object.entries(files)) {
			await session.files.write(path, contents);
		}

		// 3. Install dependencies.
		await session.commands.run(INSTALL_CMD, { timeoutMs: 120_000 });

		// 4. Start the Temporal dev server in the background.
		const temporalHandle = await session.commands.start(TEMPORAL_SERVER_CMD, {
			timeoutMs: 300_000
		});
		state.temporalPid = temporalHandle.pid;

		// 5. Wait for gRPC (port 7233) to be reachable.
		const ready = await waitForTemporal(session, maxReadinessRetries, readinessDelayMs);

		// 6. Start the worker in its own supervised background process.
		const workerHandle = await session.commands.start(WORKER_CMD, { timeoutMs: 300_000 });
		state.workerPid = workerHandle.pid;

		state.bootstrapped = true;

		return { ready, uiUrl: handle.host(TEMPORAL_UI_PORT) };
	}

	// ------------------------------------------------------------------
	// restartWorker
	// ------------------------------------------------------------------

	async function restartWorker(handle: SandboxHandle): Promise<WorkerStatus> {
		const state = getState(handle.id);
		const { session } = state;

		// Kill the existing worker if we know its PID.
		if (state.workerPid !== undefined) {
			await session.commands.kill(state.workerPid);
			state.workerPid = undefined;
		}

		// Restart ONLY the worker; the Temporal server keeps running.
		try {
			const workerHandle = await session.commands.start(WORKER_CMD, { timeoutMs: 300_000 });
			state.workerPid = workerHandle.pid;
			return { ok: true, phase: 'restarting' };
		} catch (err) {
			const stderr = err instanceof Error ? err.message : String(err);
			return { ok: false, phase: 'compile-error', stderr };
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
		sandboxes.delete(handle.id);
		await state.session.kill();
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

	return { provision, bootstrap, restartWorker, exec, writeFile, terminate };
}

// Re-export the port constants so other modules can reference them.
export { TEMPORAL_GRPC_PORT, TEMPORAL_UI_PORT };
