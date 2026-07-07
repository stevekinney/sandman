/**
 * client.ts — drive one order through its whole life from the command line.
 *
 * Run `bun run sandbox-template/client.ts` (with the dev server and worker
 * already running) to watch the happy path: start → accept → deliver → done.
 *
 * A Temporal client never runs workflow code. It talks to the server: start a
 * workflow, send it signals, ask it queries, await its result. This is
 * exactly what the Sandman control-plane buttons do — via the `temporal` CLI
 * instead of this SDK client.
 */

import { Client, Connection } from '@temporalio/client';
import {
	deliveryCompletedSignal,
	getStatusQuery,
	orderWorkflow,
	restaurantAcceptedSignal
} from './workflow.ts';
import type { OrderInput } from './shared.ts';
import { TASK_QUEUE } from './shared.ts';

async function runDemo(): Promise<void> {
	const connection = await Connection.connect({ address: 'localhost:7233' });
	const client = new Client({ connection });

	const input: OrderInput = {
		orderId: `demo-${Date.now()}`,
		items: [
			{ name: 'Cheeseburger', quantity: 2, priceCents: 1099 },
			{ name: 'Large fries', quantity: 1, priceCents: 399 }
		],
		cardLast4: '4242'
	};

	// Start the workflow. The handle is how we talk to this specific run.
	const handle = await client.workflow.start(orderWorkflow, {
		workflowId: `order-${input.orderId}`,
		taskQueue: TASK_QUEUE,
		args: [input]
	});
	process.stdout.write(`[demo] Started workflow: ${handle.workflowId}\n`);

	// Query it — read-only, answered from the workflow's live state.
	const before = await handle.query(getStatusQuery);
	process.stdout.write(`[demo] Status: ${before.status}\n`);

	// Signal it forward through both waits.
	process.stdout.write('[demo] Restaurant accepts...\n');
	await handle.signal(restaurantAcceptedSignal);

	process.stdout.write('[demo] Order delivered...\n');
	await handle.signal(deliveryCompletedSignal);

	// Await the workflow's return value.
	const result = await handle.result();
	process.stdout.write(`[demo] Final status: ${result.status}\n`);
	process.stdout.write(`[demo] Total: $${(result.totalCents / 100).toFixed(2)}\n`);

	await connection.close();
}

runDemo().catch((err) => {
	process.stderr.write(`[demo] Error: ${String(err)}\n`);
	process.exit(1);
});
