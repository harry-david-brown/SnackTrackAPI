import { Receipt } from '../../models/Receipt';
import { mapReceiptRow } from './receiptRowMapper';
/** Staging and observation JSON enter through the same validated domain decoder as SQL rows. */
export function decodeReceiptObservation(value: unknown, id = 'observation'): Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid receipt observation');
  const o = value as Record<string, unknown>;
  const m = o.monetaryDetails && typeof o.monetaryDetails === 'object' ? o.monetaryDetails as Record<string, unknown> : {};
  return mapReceiptRow({ id, user_id: o.userId, items: o.items, amount_spent: o.amountSpent,
    receipt_type: o.receiptType, restaurant_name: o.restaurantName, order_date: o.orderDate,
    data_source: o.dataSource, delivery_time: o.deliveryTime, external_id: o.externalId,
    currency_code: m.currencyCode, subtotal_amount: m.subtotal, tax_amount: m.tax, tip_amount: m.tip,
    delivery_fee_amount: m.deliveryFee, service_fee_amount: m.serviceFee, savings_amount: m.savings, resolution: o.resolution });
}
