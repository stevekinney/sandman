/**
 * worker.ts — Temporal worker bootstrap for the Sandman sandbox.
 *
 * Run this file with `bun run sandbox-template/worker.ts` (or via the
 * `worker` script in package.json) to start the worker inside the E2B VM.
 *
 * The worker connects to a locally running Temporal dev server
 * (temporal server start-dev) on gRPC port 7233.
 */

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.ts';
import { TASK_QUEUE } from './shared.ts';

/**
 * Creates and runs the Sandman Temporal worker.
 * Exits the process when the worker shuts down or encounters an error.
 */
async function run(): Promise<void> {
	const connection = await NativeConnection.connect({
		address: 'localhost:7233'
	});

	const worker = await Worker.create({
		connection,
		namespace: 'default',
		taskQueue: TASK_QUEUE,
		// workflowsPath resolves relative to this file at runtime
		workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
		activities
	});

	process.stdout.write(`[sandman] Worker running on task queue: ${TASK_QUEUE}\n`);
	process.stdout.write('[sandman] Temporal Web UI: http://localhost:8233\n');
	process.stdout.write('[sandman] Ctrl-C to stop (in-flight workflows survive on the server)\n');

	await worker.run();
}

run().catch((err) => {
	console.error('[sandman] Worker fatal error:', err);
	process.exit(1);
});
