/**
 * workflows.ts — the worker's workflow registration entry point.
 *
 * worker.ts points its `workflowsPath` here; Temporal bundles this module and
 * registers every exported workflow function by name. The actual code lives
 * in focused files:
 *
 *   - order-workflow.ts    — the main food-ordering orchestration
 *   - delivery-workflow.ts — the delivery child (+ the subscription example)
 *   - definitions.ts       — activities, retry policies, queries, updates
 *   - signals.ts           — the signals the workflows listen for
 *   - activities.ts        — the real side-effecting work
 *   - shared.ts            — domain types and constants
 *
 * Clients import signal/query/update handles from here too, so both sides of
 * the conversation agree on names.
 */

export { orderFoodWorkflow } from './order-workflow.ts';
export { deliveryWorkflow, subscriptionWorkflow, timeSkipSanity } from './delivery-workflow.ts';
export {
	applyPromoCodeUpdate,
	getStatusQuery,
	getTimelineQuery,
	updateDeliveryAddressUpdate
} from './definitions.ts';
export {
	addTipSignal,
	cancelOrderSignal,
	courierLocationUpdateSignal,
	deliveryCompletedSignal,
	foodReadySignal,
	restaurantAcceptedSignal,
	restaurantRejectedSignal
} from './signals.ts';
