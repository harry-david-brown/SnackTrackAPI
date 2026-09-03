import type { Receipt, ReceiptType, ReceiptWriteCommand } from '../../models/Receipt';

export interface ReceiptListFilters {
  readonly userId: string;
  readonly receiptType?: ReceiptType;
  readonly restaurantName?: string;
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly minAmount?: number;
  readonly maxAmount?: number;
}

export interface ReceiptPage {
  readonly receipts: Receipt[];
  readonly total: number;
}

export interface ReceiptUpsertResult {
  readonly newOrders: number;
  readonly updatedOrders: number;
  readonly unchangedOrders: number;
}

export interface ReceiptReadPort {
  findPage(filters: ReceiptListFilters, limit: number, offset: number): Promise<ReceiptPage>;
  findByUserId(userId: string): Promise<Receipt[]>;
  getLatestCsvReceiptDates(userId: string): Promise<Partial<Record<ReceiptType, Date>>>;
  getEmailReceiptStats(userId: string): Promise<{ count: number; total: number }>;
}

export interface ReceiptWritePort {
  upsertEmailReceipts(
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
  ): Promise<ReceiptUpsertResult>;
  replaceProviderExport(
    userId: string,
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
  ): Promise<void>;
  stageProviderExport(jobId: string, receipts: readonly ReceiptWriteCommand[]): Promise<void>;
  replaceStagedProviderExport(
    jobId: string,
    userId: string,
    assertWriteAllowed: () => Promise<void>,
  ): Promise<void>;
}

export interface UserCacheInvalidationPort {
  invalidateAllUserCaches(userId: string): Promise<void>;
}
