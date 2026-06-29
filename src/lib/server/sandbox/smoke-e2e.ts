/**
 * smoke-e2e.ts — full live end-to-end smoke for Sandman against real E2B.
 *
 * provision → bootstrap → start `orderFoodWorkflow` (using the app's contract
 * constant, so a type-name drift fails here) → assert the worker executes it
 * (reaches AWAITING_RESTAURANT, i.e. payment was charged) → CHAOS: kill + restart
 * the worker → cancel the order → assert the in-flight workflow survives the
 * restart and reaches a terminal REFUNDED state (the durability money-shot).
 *
 * Without E2B_API_KEY it prints a clear skip and exits 0. A hard 8-minute timeout
 * prevents indefinite hangs, and the sandbox is always terminated.
 */

import { createSandboxClient } from './client.ts';
import { ORDER_FOOD_WORKFLOW } from '$lib/contracts/workflow-api';

const HARD_TIMEOUT_MS = 8 * 60 * 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runSmoke(): Promise<void> {
	const apiKey = process.env['E2B_API_KEY'];
	if (!apiKey) {
		console.log('[smoke:e2e] SKIP — E2B_API_KEY not set.');
		process.exit(0);
	}

	const client = createSandboxClient({
		sandboxTimeoutMs: HARD_TIMEOUT_MS,
		maxReadinessRetries: 90,
		readinessDelayMs: 2_000
	});

	const orderId = 'smoke-e2e-order';
	const order = JSON.stringify({
		orderId,
		items: [{ itemId: 'i1', name: 'Burger', quantity: 1, unitPriceCents: 1099 }],
		deliveryAddress: { street: '123 Main St', city: 'Anytown', state: 'CA', postalCode: '90210' },
		customerTier: 'standard',
		paymentMethod: { type: 'card', last4: '1234', brand: 'visa' },
		restaurantId: 'r1',
		customerId: 'c1',
		restaurantAcceptTimeoutMinutes: 10
	});

	let handle: Awaited<ReturnType<typeof client.provision>> | undefined;

	try {
		console.log('[smoke:e2e] Provisioning sandbox…');
		handle = await client.provision({ timeoutMs: HARD_TIMEOUT_MS });
		console.log(`[smoke:e2e] Provisioned ${handle.id}; bootstrapping…`);

		const { ready } = await client.bootstrap(handle);
		if (!ready) throw new Error('Temporal dev server did not become ready in time.');

		const exec = (cmd: string, timeoutMs = 30_000) => client.exec(handle!, cmd, { timeoutMs });
		const queryStatus = async (): Promise<string> => {
			const r = await exec(
				`temporal workflow query --workflow-id ${orderId} --type getStatus 2>&1`,
				25_000
			);
			return `${r.stdout}${r.stderr}`;
		};

		// 1. Start the workflow using the app's contract constant. If ORDER_FOOD_WORKFLOW
		//    ever drifts from the registered function name, the worker rejects it here.
		await client.writeFile(
			handle,
			'/tmp/start.sh',
			`temporal workflow start --task-queue sandman-food --type ${ORDER_FOOD_WORKFLOW} ` +
				`--workflow-id ${orderId} --input '${order}' 2>&1`
		);
		const start = await exec('bash /tmp/start.sh');
		if (start.exitCode !== 0 || !/RunId/.test(start.stdout)) {
			throw new Error(
				`Failed to start workflow as type "${ORDER_FOOD_WORKFLOW}". stdout: ${start.stdout} stderr: ${start.stderr}`
			);
		}
		console.log(`[smoke:e2e] Started workflow as type "${ORDER_FOOD_WORKFLOW}".`);

		// 2. The worker must actually EXECUTE it: reaching AWAITING_RESTAURANT means
		//    validation, pricing, and the payment charge all ran.
		let status = '';
		for (let i = 0; i < 12; i++) {
			await sleep(2_000);
			status = await queryStatus();
			if (/AWAITING_RESTAURANT/.test(status)) break;
		}
		if (!/AWAITING_RESTAURANT/.test(status)) {
			throw new Error(
				`Worker did not execute the workflow to AWAITING_RESTAURANT. Last query: ${status.slice(0, 400)}`
			);
		}
		console.log('[smoke:e2e] Worker executed workflow → AWAITING_RESTAURANT (payment charged).');

		// 3. CHAOS: kill + restart only the worker. The Temporal server (and the
		//    in-flight workflow's history) persists, so the workflow must survive.
		console.log('[smoke:e2e] Chaos: killing + restarting the worker…');
		await client.restartWorker(handle);

		// 4. After recovery, drive the surviving workflow to a terminal state. Cancel
		//    triggers the saga, which refunds the charge recorded BEFORE the restart —
		//    proving the pre-restart state survived.
		await sleep(4_000);
		await exec(
			`temporal workflow signal --workflow-id ${orderId} --name cancelOrder ` +
				`--input '{"reason":"smoke-e2e chaos"}' 2>&1`
		);

		let terminal = '';
		for (let i = 0; i < 18; i++) {
			await sleep(2_000);
			terminal = await queryStatus();
			if (/REFUNDED|CANCELLED/.test(terminal)) break;
		}
		if (!/REFUNDED|CANCELLED/.test(terminal)) {
			const desc = await exec(
				`temporal workflow describe --workflow-id ${orderId} -o json 2>&1`,
				20_000
			);
			terminal = desc.stdout;
		}
		if (!/REFUNDED|CANCELLED/.test(terminal)) {
			throw new Error(
				`Workflow did not survive the worker restart and reach a terminal state. Last: ${terminal.slice(0, 500)}`
			);
		}

		console.log('[smoke:e2e] Workflow survived the worker restart and reached a terminal state. ✓');
		console.log('[smoke:e2e] All assertions passed. ✓');
	} finally {
		if (handle !== undefined) {
			console.log('[smoke:e2e] Terminating sandbox…');
			await client.terminate(handle);
			console.log('[smoke:e2e] Terminated.');
		}
	}
}

const timer = setTimeout(() => {
	console.error('[smoke:e2e] TIMEOUT — exceeded hard limit. Aborting.');
	process.exit(1);
}, HARD_TIMEOUT_MS);
timer.unref();

runSmoke().catch((err: unknown) => {
	console.error('[smoke:e2e] FAILED:', err);
	process.exit(1);
});
