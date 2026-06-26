/**
 * workflow-api.ts — typed stubs for the food-ordering workflow.
 *
 * // TODO(D0): Track D0 publishes the real types.
 * This file ships typed stub unions so Track E can import day one.
 * Track D will overwrite this file with the full concrete types once
 * the workflow implementation is finalised.
 */

/** All possible order lifecycle states. */
export const ORDER_STATUS = {
	Created: 'CREATED',
	Validating: 'VALIDATING',
	AwaitingRestaurant: 'AWAITING_RESTAURANT',
	Preparing: 'PREPARING',
	AwaitingCourier: 'AWAITING_COURIER',
	InDelivery: 'IN_DELIVERY',
	Delivered: 'DELIVERED',
	Cancelled: 'CANCELLED',
	Refunded: 'REFUNDED'
} as const;

/** Union of all order status string values. */
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** Signal names accepted by the food-ordering workflow. Stub — Track D fills in. */
export type SignalName =
	| 'restaurantAccepted'
	| 'restaurantRejected'
	| 'courierAssigned'
	| 'orderDelivered'
	| 'cancelOrder';

/** Query names exposed by the food-ordering workflow. Stub — Track D fills in. */
export type QueryName = 'getOrderStatus' | 'getOrderDetails';

/** Update names accepted by the food-ordering workflow. Stub — Track D fills in. */
export type UpdateName = 'updateDeliveryAddress';

/** Generic signal payload envelope. Track D will replace with discriminated union. */
export type SignalPayload = {
	signalName: SignalName;
	data?: unknown;
};

/** Generic query payload envelope. Track D will replace with discriminated union. */
export type QueryPayload = {
	queryName: QueryName;
	args?: unknown[];
};

/** Generic update payload envelope. Track D will replace with discriminated union. */
export type UpdatePayload = {
	updateName: UpdateName;
	args?: unknown[];
};

/**
 * Feature identifiers for the control-plane chaos/demo panel.
 * Stub — Track D extends this once workflow capabilities are wired.
 */
export type FeatureId =
	| 'signal'
	| 'query'
	| 'update'
	| 'timer'
	| 'activity'
	| 'child-workflow'
	| 'compensation'
	| 'kill-worker';
