/**
 * file-descriptors.ts — static description of the four files managed by the Monaco editor.
 *
 * Each descriptor carries the file name, Monaco language identifier, starter
 * content, and a readOnly flag. `shared.ts` is always read-only because it
 * contains generated type helpers that the other files import — its contents
 * should never be overwritten by the editor.
 */

/** Name of the read-only shared types file. */
export const SHARED_FILE_NAME = 'shared.ts' as const;

/** A single file surfaced in the Monaco multi-file editor. */
export type FileDescriptor = {
	/** File name shown in the tab bar. */
	name: string;
	/** Monaco language identifier (e.g. "typescript"). */
	language: string;
	/** Starter content rendered when the file is first loaded. */
	initialContents: string;
	/** When true the Monaco model is created with `readOnly: true`. */
	readOnly: boolean;
};

const WORKFLOWS_INITIAL = `/**
 * workflows.ts — Temporal workflow definitions.
 *
 * Workflow functions MUST be deterministic. Avoid:
 *   • Date.now() / new Date() — use workflow.now() instead
 *   • Math.random() — use a seeded deterministic function
 *   • fetch() / direct I/O — always wrap in an activity
 *   • setTimeout / setInterval — use workflow.sleep()
 */
import {
  defineSignal,
  defineQuery,
  defineUpdate,
  setHandler,
  condition,
  sleep,
  startChild,
  executeChild,
  continueAsNew,
  proxyActivities,
  ApplicationFailure,
  workflowInfo,
  upsertTypedSearchAttributes,
  SearchAttributeType,
} from '@temporalio/workflow';
import type { Activities } from './activities';
import type { OrderInput, OrderSnapshot } from './shared';

// Proxy activities with retry policy
const {
  chargePayment,
  notifyRestaurant,
  dispatchCourier,
  refundPayment,
  writeAuditLog,
  emitMetrics,
} = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export const cancelOrderSignal = defineSignal<[{ reason: string }]>('cancelOrder');
export const restaurantAcceptedSignal = defineSignal<[{ estimatedPrepMinutes: number }]>('restaurantAccepted');
export const restaurantRejectedSignal = defineSignal<[{ reason: string; retryable: boolean }]>('restaurantRejected');
export const foodReadySignal = defineSignal('foodReady');
export const addTipSignal = defineSignal<[{ amountCents: number }]>('addTip');

export const getStatusQuery = defineQuery<OrderSnapshot>('getStatus');

export async function OrderFoodWorkflow(input: OrderInput): Promise<OrderSnapshot> {
  let cancelled = false;
  let restaurantAccepted = false;
  let foodReady = false;
  let tipCents = 0;

  setHandler(cancelOrderSignal, ({ reason }) => {
    cancelled = true;
    void reason;
  });

  setHandler(restaurantAcceptedSignal, () => {
    restaurantAccepted = true;
  });

  setHandler(foodReadySignal, () => {
    foodReady = true;
  });

  setHandler(addTipSignal, ({ amountCents }) => {
    tipCents += amountCents;
  });

  const subtotal = input.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

  setHandler(getStatusQuery, (): OrderSnapshot => ({
    status: cancelled ? 'CANCELLED' : foodReady ? 'DELIVERED' : 'PREPARING',
    input,
    subtotalCents: subtotal,
    deliveryFeeCents: 299,
    tipCents,
    promoDiscountCents: 0,
    totalCents: subtotal + 299 + tipCents,
    attemptCounts: {},
    compensations: [],
    locationUpdateCount: 0,
    continueAsNewPending: false,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    searchAttributes: {
      OrderStatus: 'PREPARING',
      CustomerTier: input.customerTier,
      RestaurantId: input.restaurantId,
    },
  }));

  await chargePayment({ orderId: input.orderId, amountCents: subtotal });
  await notifyRestaurant({ orderId: input.orderId, restaurantId: input.restaurantId });

  // Durable timer: wait up to 10 min for restaurant acceptance
  const restaurantDeadlineMs = (input.restaurantAcceptTimeoutMinutes ?? 10) * 60 * 1000;
  const accepted = await condition(() => restaurantAccepted || cancelled, restaurantDeadlineMs);

  if (!accepted || cancelled) {
    await refundPayment({ orderId: input.orderId, amountCents: subtotal });
    return {} as OrderSnapshot;
  }

  await condition(() => foodReady);
  await dispatchCourier({ orderId: input.orderId });

  return {} as OrderSnapshot;
}
`;

const ACTIVITIES_INITIAL = `/**
 * activities.ts — Temporal activity implementations.
 *
 * Activities CAN perform I/O: HTTP calls, database writes, timers.
 * They run outside the deterministic replay engine and are safe to retry.
 */
import { Context } from '@temporalio/activity';

export type Activities = typeof activities;

const activities = {
  async chargePayment({ orderId, amountCents }: { orderId: string; amountCents: number }) {
    // Simulated payment gateway call — replace with your real provider
    await new Promise((r) => setTimeout(r, 200));
    return { charged: true, transactionId: \`txn-\${orderId}-\${amountCents}\` };
  },

  async notifyRestaurant({ orderId, restaurantId }: { orderId: string; restaurantId: string }) {
    // Heartbeat lets Temporal cancel this activity cleanly if the order is cancelled
    Context.current().heartbeat({ step: 'notifying', restaurantId });
    await new Promise((r) => setTimeout(r, 100));
    return { notified: true, notifiedAt: new Date().toISOString() };
  },

  async dispatchCourier({ orderId }: { orderId: string }) {
    await new Promise((r) => setTimeout(r, 150));
    return { courierId: \`courier-\${orderId.slice(-4)}\`, dispatchedAt: new Date().toISOString() };
  },

  async refundPayment({ orderId, amountCents }: { orderId: string; amountCents: number }) {
    await new Promise((r) => setTimeout(r, 200));
    return { refunded: true, refundId: \`ref-\${orderId}\`, amountCents };
  },

  async writeAuditLog({ orderId, event }: { orderId: string; event: string }) {
    // Local activity: runs in-process, no Temporal server round-trip
    const entry = { orderId, event, timestamp: new Date().toISOString() };
    process.stdout.write(JSON.stringify(entry) + '\\n');
  },

  async emitMetrics({ orderId, status }: { orderId: string; status: string }) {
    // Local activity: emit structured metrics without a workflow round-trip
    const metric = { orderId, status, ts: Date.now() };
    process.stdout.write(JSON.stringify(metric) + '\\n');
  },
};

export default activities;
`;

const WORKER_INITIAL = `/**
 * worker.ts — Temporal worker bootstrap.
 *
 * Starts a worker that polls the 'sandman-food' task queue and runs both
 * workflow and activity implementations. The Temporal dev server must be
 * running on localhost:7233 before this process starts.
 */
import { Worker } from '@temporalio/worker';
import activities from './activities';

async function run() {
  const worker = await Worker.create({
    workflowsPath: new URL('./workflows', import.meta.url).href,
    activities,
    taskQueue: 'sandman-food',
    connection: {
      address: 'localhost:7233',
    },
  });

  process.stdout.write('Worker started on task queue: sandman-food\\n');
  await worker.run();
}

run().catch((err: unknown) => {
  process.stderr.write(\`Worker failed: \${String(err)}\\n\`);
  process.exit(1);
});
`;

const SHARED_INITIAL = `/**
 * shared.ts — generated type helpers shared across workflow and activity files.
 *
 * READ-ONLY: this file is auto-generated from src/lib/contracts/workflow-api.ts.
 * Edit the source contract file, not this file.
 */
export type { OrderInput, OrderSnapshot, OrderItem, DeliveryAddress, PaymentMethod } from './workflow-api-types';

export type OrderInput = {
  orderId: string;
  items: Array<{ itemId: string; name: string; quantity: number; unitPriceCents: number }>;
  deliveryAddress: { street: string; city: string; state: string; postalCode: string };
  customerTier: 'standard' | 'premium' | 'enterprise';
  paymentMethod:
    | { type: 'card'; last4: string; brand: string }
    | { type: 'wallet'; provider: 'apple-pay' | 'google-pay' }
    | { type: 'credits'; balanceCents: number };
  restaurantId: string;
  customerId: string;
  promoCode?: string;
  restaurantAcceptTimeoutMinutes?: number;
};

export type OrderStatus =
  | 'CREATED'
  | 'VALIDATING'
  | 'AWAITING_RESTAURANT'
  | 'PREPARING'
  | 'AWAITING_COURIER'
  | 'IN_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';

export type OrderSnapshot = {
  status: OrderStatus;
  input: OrderInput;
  subtotalCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  promoDiscountCents: number;
  totalCents: number;
  attemptCounts: Record<string, number>;
  compensations: Array<{ action: string; timestamp: string; ok: boolean; errorMessage?: string }>;
  courier?: { courierId: string; name: string; location?: { lat: number; lng: number }; etaMinutes?: number };
  locationUpdateCount: number;
  restaurantDeadline?: string;
  deliveryDeadline?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  appliedPromoCode?: string;
  continueAsNewPending: boolean;
  searchAttributes: { OrderStatus: OrderStatus; CustomerTier: string; RestaurantId: string };
};
`;

/**
 * The four files surfaced in the Monaco editor.
 * Order matters: the first entry is selected by default.
 */
export const FILE_DESCRIPTORS: FileDescriptor[] = [
	{
		name: 'workflows.ts',
		language: 'typescript',
		initialContents: WORKFLOWS_INITIAL,
		readOnly: false
	},
	{
		name: 'activities.ts',
		language: 'typescript',
		initialContents: ACTIVITIES_INITIAL,
		readOnly: false
	},
	{
		name: 'worker.ts',
		language: 'typescript',
		initialContents: WORKER_INITIAL,
		readOnly: false
	},
	{
		name: SHARED_FILE_NAME,
		language: 'typescript',
		initialContents: SHARED_INITIAL,
		readOnly: true
	}
];
