/**
 * sandbox.ts — the A<->B<->C seam.
 *
 * Track A (SandboxClient) boots E2B Firecracker VMs and provides a typed
 * handle that Tracks B and C use to interact with the running sandbox.
 */

/** All possible lifecycle states for a sandbox VM. */
export const SANDBOX_STATUS = {
	Provisioning: 'Provisioning',
	Bootstrapping: 'Bootstrapping',
	Ready: 'Ready',
	Restarting: 'Restarting',
	Terminated: 'Terminated',
	Error: 'Error'
} as const;

/** Union of all sandbox lifecycle state strings. */
export type SandboxStatus = (typeof SANDBOX_STATUS)[keyof typeof SANDBOX_STATUS];

/** Result of running a command inside the sandbox. */
export type ExecResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

/**
 * A live reference to a provisioned sandbox VM.
 * Returned by `SandboxClient.provision` and threaded through all subsequent calls.
 */
export type SandboxHandle = {
	/** E2B sandbox identifier. */
	id: string;
	/** Current lifecycle state of the sandbox. */
	status: SandboxStatus;
	/**
	 * Returns the public hostname+port URL for the given port inside the sandbox.
	 * Delegates to the E2B `sandbox.getHost(port)` API.
	 */
	host: (port: number) => string;
	/** Short-lived access token for authenticated proxy requests. */
	accessToken: string;
};

/** The result of a worker restart attempt. */
export type WorkerStatus = {
	ok: boolean;
	/** Current phase of the worker process. */
	phase: 'restarting' | 'ready' | 'compile-error';
	/** Captured stderr from the worker process when phase is 'compile-error'. */
	stderr?: string;
};

/** Liveness of the in-sandbox Temporal server and worker processes. */
export type ProcessLiveness = {
	/** The Temporal dev server process is running (not stopped). */
	serverOnline: boolean;
	/**
	 * The Temporal worker process is actually running — reflecting a real process
	 * exit (via the command handle), not merely that a PID was assigned at spawn
	 * time. A worker that crashes flips this to false until it recovers.
	 */
	workerOnline: boolean;
};

/**
 * Primary interface for all sandbox lifecycle operations.
 * Implemented by Track A; consumed by Tracks B, C, and the control plane.
 */
export type SandboxClient = {
	/**
	 * Provisions a new E2B Firecracker VM and returns a handle.
	 * The sandbox starts in the `Provisioning` state.
	 */
	provision(opts?: { timeoutMs?: number }): Promise<SandboxHandle>;

	/**
	 * Bootstraps a provisioned sandbox: starts the Temporal dev server and worker.
	 * Returns `ready: true` once gRPC (port 7233) is reachable.
	 * Also returns the Temporal Web UI URL (port 8233, reverse-proxied by Track B).
	 */
	bootstrap(handle: SandboxHandle): Promise<{ ready: boolean; uiUrl: string }>;

	/**
	 * Hot-restarts the Temporal worker inside the sandbox without restarting
	 * the Temporal dev server. In-flight workflow state is preserved.
	 */
	restartWorker(handle: SandboxHandle): Promise<WorkerStatus>;

	/**
	 * Stops the Temporal worker inside the sandbox without restarting it.
	 * The Temporal server keeps the workflow state durable until restartWorker.
	 */
	killWorker(handle: SandboxHandle): Promise<void>;

	/**
	 * Stops the Temporal dev server process running inside the sandbox.
	 * Workflow state persists across the stop because the server was started
	 * with `--db-filename`, so a subsequent `startServer` call recovers it.
	 *
	 * Also stops the worker: once the server process dies the worker's gRPC
	 * connection dies with it, and the worker has no supervisor to restart
	 * it, so it would otherwise be left running as a dead process.
	 */
	stopServer(handle: SandboxHandle): Promise<void>;

	/**
	 * Relaunches the Temporal dev server inside the sandbox, waits for it to
	 * become reachable, re-registers the custom Search Attributes (a fresh
	 * server process starts with none registered), and restarts the worker —
	 * its connection died with the previous server process.
	 */
	startServer(handle: SandboxHandle): Promise<void>;

	/**
	 * Liveness of the Temporal server and worker processes. The server signal is
	 * the tracked PID; the worker signal is real — driven by the actual process
	 * exit reported by the E2B command handle, so a worker that crashes on its
	 * own flips to offline (and auto-restarts) instead of reporting online from a
	 * stale PID.
	 *
	 * This is the authoritative source the UI reconciles against so process
	 * state stays correct across page reloads and editor save-restarts (the
	 * client state lives in the server process, which outlives a browser
	 * reload). Returns `null` when the sandbox is unknown or already terminated.
	 */
	processLiveness(handle: SandboxHandle): ProcessLiveness | null;

	/**
	 * Runs a shell command inside the sandbox and returns its output.
	 */
	exec(handle: SandboxHandle, command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;

	/** Extends the provider-side sandbox lifetime. */
	extendTimeout(handle: SandboxHandle, timeoutMs: number): Promise<void>;

	/**
	 * Writes a file at `path` inside the sandbox with the given `contents`.
	 * Track C calls `writeFile` then `restartWorker` to hot-reload edited code.
	 */
	writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void>;

	/** Terminates the sandbox VM and frees all associated resources. */
	terminate(handle: SandboxHandle): Promise<void>;
};
