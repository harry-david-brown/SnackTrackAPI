import type { Receipt } from '../../models/Receipt';
import type { ReceiptForAnalytics } from './WrappedAnalyticsTypes';

/** Shared conversion for repository reads and the already-read Summary snapshot. */
export function projectReceiptForAnalytics(receipt: Receipt): ReceiptForAnalytics {
  if (!receipt.id) throw new Error('Persisted receipt identity is required for analytics');
  return {
    id: receipt.id,
    userId: receipt.userId,
    resolution: receipt.resolution,
    timezone: receipt.resolution?.timestamp?.timezone,
    restaurantName: receipt.restaurantName ?? null,
    orderDate: receipt.orderDate ?? null,
    amountSpent: receipt.amountSpent,
    items: receipt.items,
    receiptType: receipt.receiptType,
    dataSource: receipt.dataSource,
    deliveryTime: receipt.deliveryTime ?? null,
    currencyCode: receipt.monetaryDetails?.currencyCode ?? null,
    subtotal: receipt.monetaryDetails?.subtotal ?? null,
    tax: receipt.monetaryDetails?.tax ?? null,
    tip: receipt.monetaryDetails?.tip ?? null,
    deliveryFee: receipt.monetaryDetails?.deliveryFee ?? null,
    serviceFee: receipt.monetaryDetails?.serviceFee ?? null,
    savings: receipt.monetaryDetails?.savings ?? null,
  };
}
