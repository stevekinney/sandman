import { defineSignal } from '@temporalio/workflow';

export const cancelOrderSignal = defineSignal<[CancelOrderSignal]>('cancelOrder');
export const restaurantAcceptedSignal =
	defineSignal<[RestaurantAcceptedSignal]>('restaurantAccepted');
export const restaurantRejectedSignal =
	defineSignal<[RestaurantRejectedSignal]>('restaurantRejected');
export const foodReadySignal = defineSignal<[FoodReadySignal]>('foodReady');
export const courierLocationUpdateSignal =
	defineSignal<[CourierLocationUpdate]>('courierLocationUpdate');
export const addTipSignal = defineSignal<[AddTipSignal]>('addTip');
export const deliveryCompletedSignal = defineSignal('deliveryCompleted');
