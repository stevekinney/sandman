/**
 * worker.ts — the process that actually runs your workflow and activities.
 *
 * A worker polls a task queue on the Temporal server, executes whatever
 * workflow and activity code it is asked to, and reports results back. The
 * server is the durable brain; the worker is replaceable muscle — kill it and
 * restart it, and every in-flight workflow picks up where it left off.
 *
 * Inside the sandbox this connects to the local dev server
 * (`temporal server start-dev`) on port 7233. Saving any file in the editor
 * restarts this process; the Temporal server keeps running.
 */

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.ts';
import { TASK_QUEUE } from './shared.ts';

async function run(): Promise<void> {
	const connection = await NativeConnection.connect({
		address: 'localhost:7233'
	});

	const worker = await Worker.create({
		connection,
		namespace: 'default',
		taskQueue: TASK_QUEUE,
		// The workflow code is bundled from this file and registered by
		// function name — `orderWorkflow` becomes the workflow type.
		workflowsPath: new URL('./workflow.ts', import.meta.url).pathname,
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
