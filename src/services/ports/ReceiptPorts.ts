import type { Receipt, ReceiptType, ReceiptWriteCommand, ReceiptCurrencyCode } from '../../models/Receipt';
import type { ReceiptOutcomeFilter } from '../receipt/ReceiptHistoryFilters';
import type { ReceiptImportAccounting, ReceiptImportOutcome, ReceiptImportScope } from '../import/ReceiptImportOutcome';

export interface ReceiptListFilters {
  readonly userId: string;
  readonly receiptType?: ReceiptType;
  readonly restaurantName?: string;
  readonly startDate?: Date;
  readonly endDate?: Date;
  /** Inclusive order-local calendar boundaries, distinct from instant boundaries above. */
  readonly startDay?: string;
  readonly endDay?: string;
  readonly outcome?: ReceiptOutcomeFilter;
  readonly currencyCode?: ReceiptCurrencyCode;
  readonly minAmount?: number;
  readonly maxAmount?: number;
}

export interface ReceiptPage {
  readonly receipts: Receipt[];
  readonly total: number;
  readonly timezone?: string;
}

export interface ReceiptUpsertResult {
  readonly unresolvedOrders?: number;
  readonly newOrders: number;
  readonly updatedOrders: number;
  readonly unchangedOrders: number;
}

export interface ReceiptReadPort {
  findPage(filters: ReceiptListFilters, limit: number, offset: number): Promise<ReceiptPage>;
  findByUserId(userId: string): Promise<Receipt[]>;
  getLatestCsvReceiptDates(userId: string): Promise<Partial<Record<ReceiptType, Date>>>;
}

export interface ReceiptWritePort {
  upsertEmailReceipts(
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult>;
  replaceProviderExport(
    userId: string,
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
    batch?: {id:string;rejected:number},
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult | void>;
  stageProviderExport(jobId: string, receipts: readonly ReceiptWriteCommand[]): Promise<void>;
  replaceStagedProviderExport(
    jobId: string,
    userId: string,
    assertWriteAllowed: () => Promise<void>,
    batch?: {id:string;rejected:number},
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult | void>;
}

export interface ReceiptImportOutcomePort {
  getImportOutcome(userId: string, jobId: string, assertWriteAllowed: () => Promise<void>, scope?: ReceiptImportScope): Promise<ReceiptImportOutcome>;
}

export interface UserCacheInvalidationPort {
  invalidateAllUserCaches(userId: string): Promise<void>;
}
