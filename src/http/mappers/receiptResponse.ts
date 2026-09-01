import { Receipt, type ReceiptItem } from '../../models/Receipt';

export interface ReceiptResponseItem {
  readonly name: string;
  readonly quantity: number;
  readonly price: number;
  readonly category?: string;
  readonly customizations?: readonly string[];
}

export interface ReceiptResponse {
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

const mapItem = (item: ReceiptItem): ReceiptResponseItem => ({
  name: item.name,
  quantity: item.quantity,
  price: item.price,
  ...(item.category ? { category: item.category } : {}),
  ...(item.customizations ? { customizations: item.customizations } : {}),
});

/** Maps domain records to the canonical public receipt DTO. */
export const mapReceiptResponse = (receipt: Receipt): ReceiptResponse => {
  if (!receipt.id) throw new Error('Persisted receipt is missing its identity');
  return {
    id: receipt.id,
    userId: receipt.userId,
    items: receipt.items.map(mapItem),
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
): ReceiptPageResponse => {
  const totalPages = Math.ceil(total / limit);
  const hasMore = page < totalPages;
  return {
    items: receipts.map(mapReceiptResponse),
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
