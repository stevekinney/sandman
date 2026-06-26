/**
 * write-and-restart.ts — core logic for the files API route.
 *
 * Writes a file into the sandbox and then hot-restarts the Temporal worker.
 * The Temporal dev server keeps running so in-flight workflows survive the restart.
 *
 * Order is guaranteed: writeFile completes before restartWorker is called.
 * Tests assert this ordering via a mock SandboxClient.
 */

import type { SandboxClient, SandboxHandle, WorkerStatus } from '$lib/contracts/sandbox';

/** File path and contents to write into the sandbox. */
export type FilePayload = {
	/** Filename within the sandbox (e.g. "workflows.ts"). */
	path: string;
	/** Full UTF-8 file contents to write. */
	contents: string;
};

/**
 * Writes `payload` into the sandbox then restarts the Temporal worker.
 *
 * The Temporal dev server is left running so in-flight workflow state is
 * preserved — this is the core of the Sandman durability demonstration.
 *
 * @param client - The SandboxClient implementation (Track A).
 * @param handle - The live sandbox handle returned by `client.provision`.
 * @param payload - File path and new contents to write.
 * @returns The `WorkerStatus` returned by `restartWorker`, which includes
 *   the new phase (`ready` or `compile-error`) and any captured stderr.
 */
export async function writeAndRestart(
	client: SandboxClient,
	handle: SandboxHandle,
	payload: FilePayload
): Promise<WorkerStatus> {
	await client.writeFile(handle, payload.path, payload.contents);
	return client.restartWorker(handle);
}
