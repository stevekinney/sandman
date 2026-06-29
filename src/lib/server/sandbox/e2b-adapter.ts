/**
 * e2b-adapter.ts — minimal injectable façade over the E2B SDK.
 *
 * Exposes only the operations the SandboxClient needs. Swap out with a
 * mock in unit tests; use `createRealE2bAdapter` in production.
 */

import { Sandbox, CommandExitError } from 'e2b';
import type { Sandbox as SandboxType } from 'e2b';

/** Result of running a command to completion inside the sandbox. */
export type SandboxCommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

/** Handle for a command started in the background. */
export type SandboxCommandHandle = {
	pid: number;
	wait(): Promise<SandboxCommandResult>;
	kill(): Promise<boolean>;
};

/** Options accepted when running a command. */
export type CommandRunOpts = {
	timeoutMs?: number;
};

/** The minimal surface of a live E2B sandbox session the client needs. */
export type E2bSandboxSession = {
	sandboxId: string;
	trafficAccessToken: string | undefined;
	getHost: (port: number) => string;
	commands: {
		/** Run a command and wait for it to finish; resolves even on non-zero exit. */
		run(cmd: string, opts?: CommandRunOpts): Promise<SandboxCommandResult>;
		/** Start a command in the background; returns a handle with the process PID. */
		start(cmd: string, opts?: CommandRunOpts): Promise<SandboxCommandHandle>;
		/** Send SIGKILL to a running command by PID. */
		kill(pid: number): Promise<boolean>;
	};
	files: {
		/** Write a UTF-8 string to a file path inside the sandbox. */
		write(path: string, data: string): Promise<void>;
	};
	/** Kill the sandbox VM; resolves false if the sandbox was already gone. */
	kill(): Promise<boolean>;
};

/** Options for creating a new E2B sandbox session. */
export type E2bCreateOpts = {
	timeoutMs?: number;
	network?: {
		allowPublicTraffic?: boolean;
	};
	/**
	 * ID of a prebuilt E2B template to use when creating the sandbox.
	 * When set, the E2B SDK calls `Sandbox.create(templateId, opts)` instead
	 * of `Sandbox.create(opts)`, which skips the default base image and boots
	 * the named prebuilt image. When omitted, the E2B default base image is used.
	 */
	templateId?: string;
};

/** Injectable abstraction over the E2B SDK for unit-testable sandbox operations. */
export type E2bAdapter = {
	create(opts?: E2bCreateOpts): Promise<E2bSandboxSession>;
};

/** Type guard that checks whether a thrown value is an E2B CommandExitError. */
function isCommandExitError(
	err: unknown
): err is { exitCode: number; stdout: string; stderr: string } {
	return err instanceof CommandExitError;
}

/**
 * Wraps a real E2B `Sandbox` instance in the `E2bSandboxSession` interface.
 * Catches `CommandExitError` so callers always receive a result object rather
 * than a thrown exception for non-zero exit codes.
 *
 * Exported for unit testing; use `createRealE2bAdapter` in production code.
 */
export function wrapSandbox(sandbox: SandboxType): E2bSandboxSession {
	return {
		sandboxId: sandbox.sandboxId,
		trafficAccessToken: sandbox.trafficAccessToken,

		getHost(port) {
			return `https://${sandbox.getHost(port)}`;
		},

		commands: {
			async run(cmd, opts) {
				try {
					const result = await sandbox.commands.run(cmd, { timeoutMs: opts?.timeoutMs });
					return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
				} catch (err) {
					if (isCommandExitError(err)) {
						return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
					}
					throw err;
				}
			},

			async start(cmd, opts) {
				const handle = await sandbox.commands.run(cmd, {
					background: true,
					timeoutMs: opts?.timeoutMs
				});
				return {
					pid: handle.pid,
					async wait() {
						try {
							const result = await handle.wait();
							return {
								exitCode: result.exitCode,
								stdout: result.stdout,
								stderr: result.stderr
							};
						} catch (err) {
							if (isCommandExitError(err)) {
								return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
							}
							throw err;
						}
					},
					async kill() {
						return sandbox.commands.kill(handle.pid);
					}
				};
			},

			async kill(pid) {
				return sandbox.commands.kill(pid);
			}
		},

		files: {
			async write(path, data) {
				await sandbox.files.write(path, data);
			}
		},

		async kill() {
			return sandbox.kill();
		}
	};
}

/**
 * Creates an `E2bAdapter` backed by the real `e2b` npm package.
 * Requires `E2B_API_KEY` to be set in the environment.
 *
 * When `opts.templateId` is provided, the sandbox is created from that prebuilt
 * template (fast path). Otherwise the E2B default base image is used and the
 * bootstrap step installs the Temporal CLI and worker deps on demand.
 */
export function createRealE2bAdapter(): E2bAdapter {
	return {
		async create(opts = {}) {
			const sandboxOpts = { timeoutMs: opts.timeoutMs, network: opts.network };
			const sandbox =
				opts.templateId !== undefined
					? await Sandbox.create(opts.templateId, sandboxOpts)
					: await Sandbox.create(sandboxOpts);
			return wrapSandbox(sandbox);
		}
	};
}
