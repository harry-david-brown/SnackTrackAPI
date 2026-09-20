import { Receipt, type ReceiptItem } from '../../models/Receipt';
import type { CheckoutDifference } from '../../models/ReceiptResolution';
import { mapReceiptOrderOutcome, type ReceiptOrderOutcomeResponse } from './receiptOrderOutcome';
import { getLocalDateKey } from '../../utils/timezone';
import { recordedItemPrice, usableItemUnitPrice } from '../../services/receipt/ItemPrice';

export interface ReceiptResponseItem {
  readonly name: string;
  readonly quantity: number;
  readonly price: number;
  readonly category?: string;
  readonly customizations?: readonly string[];
  readonly configuredLineTotal?: number;
  readonly recordedPrice?: number;
  readonly inferred?: boolean;
}

export interface ReceiptResponse {
  readonly orderDay?: string | null;
  readonly orderOutcome?: ReceiptOrderOutcomeResponse;
  readonly reconciliation?: { status: 'merged' | 'standalone' | 'unresolved'; method: string; reason?: string };
  readonly sources?: readonly string[];
  readonly checkoutDifference?: CheckoutDifference;
  readonly currencyCode?: string;
  readonly amountBasis?: string;
  readonly evidenceSummary?: string;
  readonly resolutionVersion?: number;
  readonly id: string;
  readonly userId: string;
  readonly items: readonly ReceiptResponseItem[];
  readonly amountSpent: number;
  readonly receiptType: Receipt['receiptType'];
  readonly restaurantName: string | null;
  readonly orderDate: string | null;
  readonly dataSource: Receipt['dataSource'];
}

export interface ReceiptPageResponse {
  readonly items: readonly ReceiptResponse[];
  readonly pageInfo: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
    readonly hasMore: boolean;
    readonly nextPage: number | null;
  };
}

const mapItem = (item: ReceiptItem, receipt: Receipt): ReceiptResponseItem => {
  const unitPrice = usableItemUnitPrice(item, { receiptType: receipt.receiptType, dataSource: receipt.dataSource });
  const recorded = recordedItemPrice(item) ??
    (unitPrice === undefined && receipt.receiptType === 'uber_eats' && receipt.dataSource === 'csv' && item.quantity > 1
      ? item.price * item.quantity
      : undefined);
  return {
    ...(unitPrice !== undefined && item.evidence && item.evidence.customizationPriceBasis !== 'unavailable'
      ? { configuredLineTotal: item.evidence.configuredLineTotal }
      : {}),
    ...(unitPrice === undefined && recorded !== undefined ? { recordedPrice: recorded } : {}),
    ...(item.evidence ? { inferred: item.evidence.method !== 'observed' } : {}),
    name: item.name,
    quantity: item.quantity,
    price: unitPrice ?? 0,
    ...(item.category ? { category: item.category } : {}),
    ...(item.customizations ? { customizations: item.customizations } : {}),
  };
};

/** Maps domain records to the canonical public receipt DTO. */
export const mapReceiptResponse = (receipt: Receipt, context?: { accountTimezone?: string }): ReceiptResponse => {
  if (!receipt.id) throw new Error('Persisted receipt is missing its identity');
  const orderOutcome = mapReceiptOrderOutcome(receipt, context?.accountTimezone);
  return {
    ...(context?.accountTimezone === undefined ? {} : { orderDay: orderOutcome ? orderOutcome.orderDay : getLocalDateKey(receipt.orderDate ?? null, receipt.resolution?.timestamp?.timezone ?? context.accountTimezone) }),
    ...(orderOutcome ? { orderOutcome } : {}),
    ...(receipt.resolution?.reconciliation ? {reconciliation:{status:receipt.resolution.reconciliation.status,method:receipt.resolution.reconciliation.method,...(receipt.resolution.reconciliation.reason ? {reason:receipt.resolution.reconciliation.reason} : {})}} : {}),
    sources: receipt.resolution?.sources ?? [receipt.dataSource],
    ...(receipt.resolution?.checkoutDifference ? { checkoutDifference: receipt.resolution.checkoutDifference } : {}),
    currencyCode: receipt.monetaryDetails?.currencyCode ?? 'UNKNOWN',
    amountBasis: receipt.resolution?.amountBasis ?? 'legacy',
    ...(receipt.resolution ? { resolutionVersion: receipt.resolution.version } : {}),
    evidenceSummary: receipt.resolution?.amountBasis === 'receipt_total' ? 'Based on receipt total' : receipt.resolution?.amountBasis === 'item_subtotal' ? `Item subtotal; final charge unavailable${receipt.resolution?.currencyInference ? '; currency inferred' : ''}` : 'Based on exported or legacy totals',
    id: receipt.id,
    userId: receipt.userId,
    items: receipt.items.map(item => mapItem(item, receipt)),
    amountSpent: receipt.amountSpent,
    receiptType: receipt.receiptType,
    restaurantName: receipt.restaurantName ?? null,
    orderDate: receipt.orderDate?.toISOString() ?? null,
    dataSource: receipt.dataSource,
  };
};

export const mapReceiptPageResponse = (
  receipts: readonly Receipt[],
  total: number,
  page: number,
  limit: number,
  accountTimezone?: string,
): ReceiptPageResponse => {
  const totalPages = Math.ceil(total / limit);
  const hasMore = page < totalPages;
  return {
    items: receipts.map(receipt => mapReceiptResponse(receipt, { accountTimezone })),
    pageInfo: {
      page,
      limit,
      total,
      totalPages,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    },
  };
};
