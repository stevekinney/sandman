<script lang="ts">
	/**
	 * control-plane.svelte — root composition component for the Sandman demo.
	 *
	 * Renders a start-order form before any workflow is running, then switches
	 * to the full control panel (signals, queries, updates, event rail, chaos)
	 * once a workflow run is active.
	 *
	 * `controller` is the seam: production callers pass a `FetchController`;
	 * tests inject `MockTemporalController`.
	 *
	 * The order timeline (`OrderTimeline` → Cinder `RunStepTimeline`) is rendered
	 * directly. Its live data (`timelineEntries`) is supplied by the parent, which
	 * owns the `getTimeline` poll — keeping this component's own controller-query
	 * surface limited to explicit user actions. The parent learns the active run
	 * via the `onstarted` callback so it can scope its poll to the workflow ID.
	 */
	import Badge from '@lostgradient/cinder/badge';
	import '@lostgradient/cinder/badge/styles';
	import type {
		CommandLogDraft,
		CommandLogEntry,
		CommandLogPrimitive,
		TemporalController,
		WorkflowRun
	} from './types.ts';
	import type { WorkflowEvent } from '$lib/contracts/events';
	import type {
		ControlId,
		OrderInput,
		QueryName,
		SignalName,
		TimelineEntry,
		UpdateName
	} from '$lib/contracts/workflow-api';
	import StartOrderForm from './start-order-form.svelte';
	import SignalControls from './signal-controls.svelte';
	import QueryPanel from './query-panel.svelte';
	import UpdateControls from './update-controls.svelte';
	import EventRail from './event-rail.svelte';
	import ChaosControls from './chaos-controls.svelte';
	import OrderTimeline from './order-timeline.svelte';

	let {
		controller,
		events = [],
		timelineEntries = [],
		recommendedControl,
		onstarted,
		onworkflowevent,
		oncommand
	}: {
		controller: TemporalController;
		/**
		 * Live workflow event stream, provided by the parent (e.g. via SSE or
		 * periodic polling). `EventRail` handles sorting and deduplication internally.
		 */
		events?: WorkflowEvent[];
		/**
		 * Live `getTimeline` snapshot, provided by the parent. Rendered as a
		 * Cinder `RunStepTimeline`. Defaults to empty (timeline hidden) so tests
		 * and pre-start states render nothing.
		 */
		timelineEntries?: TimelineEntry[];
		/** Current guided-tour action, rendered as the primary next step. */
		recommendedControl?: ControlId;
		/** Called once when a workflow run starts, so the parent can scope its poll. */
		onstarted?: (run: WorkflowRun) => void;
		/** Emits UI-only workflow events, such as successful queries and worker restarts. */
		onworkflowevent?: (event: WorkflowEvent) => void;
		/** Emits a command-log entry for every control-plane operation. */
		oncommand?: (entry: CommandLogEntry) => void;
	} = $props();

	let workflowRun = $state<WorkflowRun | null>(null);
	let activeOrder = $state<OrderInput | null>(null);
	let nextControlEventSequence = $state(10_000);
	let nextCommandId = $state(1);
	const deliveryFeeCents = 299;
	const progressSteps = [
		{ label: 'Placed', statuses: ['CREATED', 'VALIDATING', 'PAYMENT_CHARGED'] },
		{ label: 'Confirmed', statuses: ['AWAITING_RESTAURANT', 'RESTAURANT_ACCEPTED'] },
		{ label: 'Preparing', statuses: ['PREPARING', 'READY_FOR_PICKUP'] },
		{ label: 'Courier', statuses: ['COURIER_ASSIGNED', 'OUT_FOR_DELIVERY'] },
		{ label: 'Delivered', statuses: ['DELIVERED', 'COMPLETED'] }
	];
	const latestTimelineEntry = $derived(timelineEntries.at(-1));
	const progressLabel = $derived(latestTimelineEntry?.description ?? 'Workflow started');
	const activeProgressIndex = $derived.by(() => {
		const status = latestTimelineEntry?.status;
		if (!status) return 0;
		const index = progressSteps.findIndex((step) => step.statuses.includes(status));
		return index === -1 ? 0 : index;
	});
	const deliveryWorkflowId = $derived(
		activeOrder === null ? undefined : `delivery-${activeOrder.orderId}`
	);
	const nextActionLabel = $derived(getControlLabel(recommendedControl));
	const loggingController = $derived(createLoggingController(controller));

	function formatMoney(cents: number): string {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
			cents / 100
		);
	}

	function getOrderTotal(order: OrderInput): number {
		return (
			order.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0) +
			deliveryFeeCents
		);
	}

	function handleStarted(run: WorkflowRun, order: OrderInput): void {
		workflowRun = run;
		activeOrder = order;
		onstarted?.(run);
		emitControlEvent('WorkflowExecutionStarted', run.workflowId);
	}

	function emitControlEvent(type: string, workflowId = workflowRun?.workflowId): void {
		onworkflowevent?.({
			sequence: nextControlEventSequence++,
			type,
			timestamp: new Date().toISOString(),
			workflowId
		});
	}

	function recordCommand(
		draft: CommandLogDraft,
		status: CommandLogEntry['status']
	): CommandLogEntry {
		const entry = {
			...draft,
			id: nextCommandId++,
			status,
			timestamp: new Date().toISOString()
		};
		oncommand?.(entry);
		return entry;
	}

	function recordCommandResult(
		entry: CommandLogEntry,
		result: unknown,
		status: CommandLogEntry['status']
	): void {
		oncommand?.({
			...entry,
			status,
			result,
			error: undefined,
			timestamp: new Date().toISOString()
		});
	}

	function recordCommandError(entry: CommandLogEntry, error: unknown): void {
		oncommand?.({
			...entry,
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
			timestamp: new Date().toISOString()
		});
	}

	function createLoggingController(baseController: TemporalController): TemporalController {
		return {
			start: async (input) => {
				const entry = recordCommand(
					buildCommandDraft('Place Order', 'workflow', 'POST /api/sandbox/[id]/workflow', {
						temporalCommand: 'temporal workflow start --type orderFoodWorkflow',
						workflowId: input.orderId,
						payload: input
					}),
					'running'
				);
				try {
					const result = await baseController.start(input);
					recordCommandResult(entry, result, 'succeeded');
					return result;
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			},
			signal: async (workflowId, name, payload) => {
				const entry = recordCommand(
					buildCommandDraft(
						getSignalControlLabel(name),
						'signal',
						'POST /api/sandbox/[id]/workflow/signal',
						{
							temporalCommand: `temporal workflow signal --name ${name}`,
							workflowId,
							payload
						}
					),
					'running'
				);
				try {
					await baseController.signal(workflowId, name, payload);
					recordCommandResult(entry, { ok: true }, 'succeeded');
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			},
			query: async (workflowId, name) => {
				const entry = recordCommand(
					buildCommandDraft(
						getQueryControlLabel(name),
						'query',
						'GET /api/sandbox/[id]/workflow/query',
						{
							temporalCommand: `temporal workflow query --type ${name}`,
							workflowId
						}
					),
					'running'
				);
				try {
					const result = await baseController.query(workflowId, name);
					recordCommandResult(entry, result, 'succeeded');
					return result;
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			},
			update: async (workflowId, name, input) => {
				const entry = recordCommand(
					buildCommandDraft(
						getUpdateControlLabel(name),
						'update',
						'POST /api/sandbox/[id]/workflow/update',
						{
							temporalCommand: `temporal workflow update execute --name ${name}`,
							workflowId,
							payload: input
						}
					),
					'running'
				);
				try {
					const result = await baseController.update(workflowId, name, input);
					recordCommandResult(entry, result, 'succeeded');
					return result;
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			},
			killWorker: async () => {
				const entry = recordCommand(
					buildCommandDraft('Kill Worker', 'worker', 'POST /api/sandbox/[id]/worker/kill', {
						temporalCommand: 'pkill -f sandbox-template/worker.ts'
					}),
					'running'
				);
				try {
					await baseController.killWorker();
					recordCommandResult(entry, { ok: true }, 'succeeded');
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			},
			restartWorker: async () => {
				const entry = recordCommand(
					buildCommandDraft('Restart Worker', 'worker', 'POST /api/sandbox/[id]/worker/restart', {
						temporalCommand: 'bun run sandbox-template/worker.ts'
					}),
					'running'
				);
				try {
					await baseController.restartWorker();
					recordCommandResult(entry, { ok: true }, 'succeeded');
				} catch (error) {
					recordCommandError(entry, error);
					throw error;
				}
			}
		};
	}

	function buildCommandDraft(
		label: string,
		primitive: CommandLogPrimitive,
		apiRoute: string,
		options: {
			temporalCommand: string;
			workflowId?: string;
			runId?: string;
			payload?: unknown;
		}
	): CommandLogDraft {
		return {
			label,
			primitive,
			apiRoute,
			temporalCommand: options.temporalCommand,
			workflowId: options.workflowId,
			runId: options.runId,
			payload: options.payload
		};
	}

	function getSignalControlLabel(name: SignalName): string {
		switch (name) {
			case 'cancelOrder':
				return 'Cancel Order';
			case 'restaurantAccepted':
				return 'Restaurant Accepted';
			case 'restaurantRejected':
				return 'Restaurant Rejected';
			case 'foodReady':
				return 'Food Ready';
			case 'courierLocationUpdate':
				return 'Update Courier Location';
			case 'addTip':
				return 'Add Tip';
			case 'deliveryCompleted':
				return 'Complete Delivery';
		}
	}

	function getQueryControlLabel(name: QueryName): string {
		return name === 'getStatus' ? 'Get Status' : 'Get Timeline';
	}

	function getUpdateControlLabel(name: UpdateName): string {
		return name === 'updateDeliveryAddress' ? 'Update Address' : 'Apply Promo';
	}

	function getControlLabel(control: ControlId | undefined): string {
		if (control === undefined) return 'Place Order';
		switch (control) {
			case 'start-order':
				return 'Place Order';
			case 'cancel-order':
				return 'Cancel Order';
			case 'accept-restaurant':
				return 'Restaurant Accepted';
			case 'reject-restaurant':
				return 'Restaurant Rejected';
			case 'food-ready':
				return 'Food Ready';
			case 'update-location':
				return 'Update Courier Location';
			case 'add-tip':
				return 'Add Tip';
			case 'update-address':
				return 'Update Address';
			case 'apply-promo':
				return 'Apply Promo';
			case 'complete-delivery':
				return 'Complete Delivery';
			case 'kill-worker':
				return 'Kill Worker';
			case 'query-status':
				return 'Get Status';
			case 'query-timeline':
				return 'Get Timeline';
		}
	}
</script>

<div class="control-plane">
	{#if workflowRun === null}
		<StartOrderForm controller={loggingController} onstarted={handleStarted} />
	{:else}
		<section class="next-action" aria-label="Recommended next action">
			<p class="eyebrow">Recommended next action</p>
			<p>{nextActionLabel}</p>
		</section>

		{#if activeOrder}
			<section class="order-tracker" aria-labelledby="active-order-title">
				<div class="tracker-heading">
					<div>
						<p class="eyebrow">Live order</p>
						<h2 id="active-order-title">Kitsune Kitchen is working on it</h2>
					</div>
					<Badge variant="info">{progressLabel}</Badge>
				</div>

				<ol class="progress-steps" aria-label="Order progress">
					{#each progressSteps as step, index (step.label)}
						<li
							class:complete={index < activeProgressIndex}
							class:current={index === activeProgressIndex}
						>
							<span>{index + 1}</span>
							{step.label}
						</li>
					{/each}
				</ol>

				<div class="active-order-line">
					<div>
						<p class="active-order-item">
							{activeOrder.items.map((item) => `${item.quantity}x ${item.name}`).join(', ')}
						</p>
						<p class="active-order-detail">
							{activeOrder.deliveryAddress.street}, {activeOrder.deliveryAddress.city}
						</p>
					</div>
					<p class="active-order-total">{formatMoney(getOrderTotal(activeOrder))}</p>
				</div>
			</section>
		{/if}

		<header class="run-header" aria-label="Temporal workflow run">
			<h3>Temporal controls</h3>
			<dl class="run-meta">
				<div>
					<dt>Workflow ID</dt>
					<dd>{workflowRun.workflowId}</dd>
				</div>
				<div>
					<dt>Run ID</dt>
					<dd>{workflowRun.runId}</dd>
				</div>
			</dl>
		</header>

		<SignalControls
			controller={loggingController}
			workflowId={workflowRun.workflowId}
			{deliveryWorkflowId}
		/>

		<QueryPanel
			controller={loggingController}
			workflowId={workflowRun.workflowId}
			onqueried={(name) => {
				if (name === 'getStatus') emitControlEvent('QueryCompleted');
			}}
		/>

		<UpdateControls controller={loggingController} workflowId={workflowRun.workflowId} />

		<ChaosControls
			controller={loggingController}
			onrestarted={() => emitControlEvent('WorkerRestarted')}
		/>

		<EventRail {events} />

		<OrderTimeline entries={timelineEntries} />
	{/if}
</div>

<style>
	.next-action {
		padding: 0.875rem 1rem;
		border: 1px solid #38bdf8;
		border-radius: 0.5rem;
		background: #082f49;
	}

	.next-action p:last-child {
		margin: 0;
		color: #f0f9ff;
		font-weight: 800;
	}

	.order-tracker {
		padding: 1rem;
		border: 1px solid var(--cinder-border, #334155);
		border-radius: 0.5rem;
		background: var(--cinder-surface, #0f172a);
	}

	.tracker-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.order-tracker h2,
	.run-header h3 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.25;
		color: var(--cinder-text, #e2e8f0);
	}

	.eyebrow {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.progress-steps {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 0.35rem;
		margin: 1rem 0;
		padding: 0;
		list-style: none;
	}

	.progress-steps li {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		align-items: center;
		min-width: 0;
		color: var(--cinder-text-muted, #94a3b8);
		font-size: 0.72rem;
		text-align: center;
	}

	.progress-steps span {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid var(--cinder-border, #334155);
		border-radius: 999px;
		color: var(--cinder-text-muted, #94a3b8);
		background: color-mix(in srgb, var(--cinder-surface, #0f172a), #000 12%);
	}

	.progress-steps li.complete,
	.progress-steps li.current {
		color: var(--cinder-text, #e2e8f0);
	}

	.progress-steps li.complete span,
	.progress-steps li.current span {
		border-color: #22c55e;
		color: #052e16;
		background: #86efac;
	}

	.active-order-line {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.active-order-item,
	.active-order-total {
		margin: 0;
		font-weight: 700;
		color: var(--cinder-text, #e2e8f0);
	}

	.active-order-detail {
		margin: 0.2rem 0 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.run-header {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 0.5rem;
	}
</style>
