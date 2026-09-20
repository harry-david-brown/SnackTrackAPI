import { exportCityTimezone, exportAddressCurrency } from '../receipt/ReceiptTimeConvention';
import { reconstructUberItems } from '../receipt/OrderReconstruction';
import { createUberItemPriceResolver } from '../receipt/UberItemPriceResolver';
import { moneySum } from '../../models/ReceiptResolution';
import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { v4 as uuidv4 } from 'uuid';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import { getDefaultTimezone, zonedDateTimeToUtc } from '../../utils/timezone';
import { silentStructuredLogger, StructuredLogger } from '../core/StructuredLogger';
import { ValidationError } from '../../core/errors';
import { CURRENT_UBER_EXPORT_PARSER_VERSION, type FulfillmentStatus, type OrderSourceEvidence } from '../../models/OrderEvidence';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import { doorDashExportEvidence } from '../receipt/DoorDashExportEvidence';

export interface UberCsvRow {
  City_Name: string;
  Restaurant_Name: string;
  Request_Time_Local: string;
  Final_Delivery_Time_Local: string;
  Order_Status: string;
  Item_Name: string;
  Item_quantity: string;
  Customizations: string;
  Customization_Cost_Local: string;
  Special_Instructions: string;
  Item_Price: string;
  Order_Price: string;
  Currency: string;
}

export interface DoorDashCsvRow {
  ITEM: string;
  CATEGORY: string;
  STORE_NAME: string;
  UNIT_PRICE: string;
  QUANTITY: string;
  SUBTOTAL: string;
  CREATED_AT: string;
  DELIVERY_TIME: string;
  DELIVERY_ADDRESS: string;
}

interface UberOrderGroup {
  readonly first: UberCsvRow;
  readonly rows: UberCsvRow[];
  readonly items: ReceiptItem[];
  maxOrderPrice: number | null;
}

interface DoorDashOrderGroup {
  readonly first: DoorDashCsvRow;
  readonly rows: DoorDashCsvRow[];
  readonly items: ReceiptItem[];
  subtotal: number | null;
}

type CsvRecord = Record<string, unknown>;
const csvRecord = (value: unknown): CsvRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('CSV row must be an object');
  }
  return value as CsvRecord;
};
const csvString = (row: CsvRecord, field: string): string => {
  const value = row[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`CSV field ${field} must be a string`);
  return value;
};
const decodeCsvRow = <Row extends object>(value: unknown, fields: readonly string[]): Row => {
  const source = csvRecord(value);
  return Object.fromEntries(fields.map((field) => [field, csvString(source, field)])) as Row;
};
const UBER_FIELDS: readonly (keyof UberCsvRow)[] = [
  'City_Name',
  'Restaurant_Name',
  'Request_Time_Local',
  'Final_Delivery_Time_Local',
  'Order_Status',
  'Item_Name',
  'Item_quantity',
  'Customizations',
  'Customization_Cost_Local',
  'Special_Instructions',
  'Item_Price',
  'Order_Price',
  'Currency',
];
const DOORDASH_FIELDS: readonly (keyof DoorDashCsvRow)[] = [
  'ITEM',
  'CATEGORY',
  'STORE_NAME',
  'UNIT_PRICE',
  'QUANTITY',
  'SUBTOTAL',
  'CREATED_AT',
  'DELIVERY_TIME',
  'DELIVERY_ADDRESS',
];
const MAX_CSV_ROWS = 100_000;
const MAX_CSV_ORDERS = 25_000;
const MAX_CSV_COLUMNS = 64;
const MAX_CSV_ROW_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ITEMS_PER_ORDER = 500;
const MAX_INVALID_ROWS = 1_000;
const MAX_INVALID_ROW_RATIO = 0.10;
const MAX_AMOUNT = 1_000_000;
const MIN_ORDER_DATE = Date.UTC(2009, 0, 1);
const MAX_TEXT = { merchant: 255, item: 500, customization: 2_000, category: 100, address: 500 } as const;

const parserOptions = {
  strict: true,
  maxRowBytes: MAX_CSV_ROW_BYTES,
  mapHeaders: ({ header }: { header: string }) => header.replace(/^\uFEFF/, '').trim(),
};

const normalizeCsvHeader = (header: string): string => {
  const trimmed = header.replace(/^\uFEFF/, '').trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"').trim()
    : trimmed;
};

const readCsvHeaders = (content: string): string[] =>
  content.split(/\r?\n/, 1)[0].split(',').map(normalizeCsvHeader);

const boundedText = (value: string, maximum: number): string => {
  const normalized = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length > maximum) throw new ValidationError('CSV field exceeds the safe length limit', 'file');
  return normalized;
};

const finiteAmount = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_AMOUNT) throw new ValidationError('CSV contains an invalid monetary amount', 'file');
  return parsed;
};

const finiteQuantity = (value: string): number => {
  const parsed = Number(value || '1');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new ValidationError('CSV contains an invalid quantity', 'file');
  return parsed;
};

const safeDate = (value: Date): boolean => value.getTime() >= MIN_ORDER_DATE && value.getTime() <= Date.now() + 86_400_000;
const exceedsInvalidRowBudget = (invalidRows: number, rowCount: number): boolean =>
  invalidRows > MAX_INVALID_ROWS || (rowCount > 0 && invalidRows / rowCount > MAX_INVALID_ROW_RATIO);

export const decodeUberCsvRow = (value: unknown): UberCsvRow =>
  decodeCsvRow<UberCsvRow>(value, UBER_FIELDS);
export const decodeDoorDashCsvRow = (value: unknown): DoorDashCsvRow =>
  decodeCsvRow<DoorDashCsvRow>(value, DOORDASH_FIELDS);

export interface ImportResult {
  statusCounts?: Partial<Record<FulfillmentStatus, number>>;
  unsupportedStatusRows?: Record<string, number>;
  rejectedRecords?: number;
  success: boolean;
  totalOrders: number;
  totalReceipts: number;
  totalAmount: number;
  errors: string[];
  receipts: Receipt[];
}

export class CsvImportService {
  constructor(private readonly logger: StructuredLogger = silentStructuredLogger) {}

  /**
   * Detect CSV format (Uber Eats or DoorDash)
   * Also detects DoorDash profile_details.csv files (which don't have order data)
   */
  detectCsvFormat(csvBuffer: Buffer): 'uber' | 'doordash' | 'unknown' {
    const content = csvBuffer.toString();
    const headers = new Set(readCsvHeaders(content).map((header) => header.toLowerCase()));

    // Check for DoorDash order headers
    if (
      headers.has('item') &&
      headers.has('store_name') &&
      headers.has('created_at') &&
      headers.has('subtotal')
    ) {
      return 'doordash';
    }

    // Check for Uber Eats headers
    if (
      headers.has('restaurant_name') &&
      headers.has('request_time_local') &&
      headers.has('order_price') &&
      headers.has('item_name')
    ) {
      return 'uber';
    }

    return 'unknown';
  }

  async detectCsvFormatFromFile(filePath: string): Promise<'uber' | 'doordash' | 'unknown'> {
    return this.detectCsvFormat(await this.readHeaderSample(filePath));
  }

  async validateCsvPath(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    return this.validateCsvFormat(await this.readHeaderSample(filePath));
  }

  async validateCsvPathForProvider(filePath: string, provider: 'uber_eats' | 'doordash'): Promise<{ valid: boolean; errors: string[] }> {
    const sample = await this.readHeaderSample(filePath);
    const validation = this.validateCsvFormat(sample);
    const format = this.detectCsvFormat(sample);
    const expected = provider === 'uber_eats' ? 'uber' : 'doordash';
    return format === expected ? validation : { valid: false, errors: ['The CSV belongs to a different or unsupported export provider.'] };
  }

  async parseCsvPath(filePath: string, userId: string, timezone?: string, policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY): Promise<ImportResult> {
    const format = await this.detectCsvFormatFromFile(filePath);
    if (format === 'doordash') return this.parseDoorDashCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone(), policyVersion);
    if (format === 'uber') {
      return this.parseUberEatsCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone(), policyVersion);
    }
    throw new Error('Unknown CSV format. Expected Uber Eats or DoorDash format.');
  }

  async parseCsvPathForProvider(filePath: string, provider: 'uber_eats' | 'doordash', userId: string, timezone?: string, policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY): Promise<ImportResult> {
    return provider === 'uber_eats'
      ? this.parseUberEatsCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone(), policyVersion)
      : this.parseDoorDashCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone(), policyVersion);
  }

  /**
   * Parse CSV file and convert to Receipt objects
   * Auto-detects format and routes to appropriate parser
   */
  async parseCsvFile(csvBuffer: Buffer, userId: string, timezone?: string, policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY): Promise<ImportResult> {
    const format = this.detectCsvFormat(csvBuffer);

    if (format === 'doordash') {
      return this.parseDoorDashCsv(csvBuffer, userId, timezone || getDefaultTimezone(), policyVersion);
    } else if (format === 'uber') {
      const userTimezone = timezone || getDefaultTimezone();
      return this.parseUberEatsCsv(csvBuffer, userId, userTimezone, policyVersion);
    } else {
      throw new Error('Unknown CSV format. Expected Uber Eats or DoorDash format.');
    }
  }

  /**
   * Parse Uber Eats CSV file and convert to Receipt objects
   */
  async parseUberEatsCsv(
    csvBuffer: Buffer | Readable,
    userId: string,
    timezone: string = getDefaultTimezone(),
    // Shadow/replay opt-in until all metric consumers support order outcomes.
    policyVersion: 2 | 3 = ACTIVE_RECEIPT_POLICY,
  ): Promise<ImportResult> {
    const results = new Map<string, UberOrderGroup>();
    const errors: string[] = [];
    let rowCount = 0;
    let invalidRows = 0;
    const unsupportedStatusRows = new Map<string, number>();

    return new Promise((resolve, reject) => {
      const stream = Buffer.isBuffer(csvBuffer) ? Readable.from(csvBuffer.toString()) : csvBuffer;

      stream
        .pipe(csv(parserOptions))
        .on('data', (value: unknown) => {
          rowCount++;
          if (rowCount > MAX_CSV_ROWS) {
            stream.destroy();
            reject(new ValidationError('CSV exceeds the maximum row count', 'file'));
            return;
          }
          try {
            const row = decodeUberCsvRow(value);
            // An absent amount is unknown. It is not evidence of a refund.
            row.Restaurant_Name = boundedText(row.Restaurant_Name, MAX_TEXT.merchant);
            row.Item_Name = boundedText(row.Item_Name, MAX_TEXT.item);
            row.Customizations = boundedText(row.Customizations, MAX_TEXT.customization);
            if (!row.Restaurant_Name || !row.Request_Time_Local) {
              invalidRows += 1;
              return;
            }

            // Handle empty Order_Price (refunded orders)
            if (policyVersion === 2 && (!row.Order_Price || row.Order_Price === '')) {
              row.Order_Price = '0.00'; // Set to 0 for refunded orders
            }

            const status = row.Order_Status.trim().toLowerCase().replace('cancelled', 'canceled');
            if (policyVersion === 3 && !['completed', 'canceled', 'failed', 'unfulfilled'].includes(status)) {
              const boundedStatus = boundedText(status || 'missing', 100);
              unsupportedStatusRows.set(boundedStatus, (unsupportedStatusRows.get(boundedStatus) ?? 0) + 1);
              return;
            }
            if (policyVersion === 2 && row.Order_Status !== 'completed') {
              return;
            }

            const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}`;
            const quantity = policyVersion === 3 && !row.Item_Name ? 1 : finiteQuantity(row.Item_quantity);
            const linePrice = finiteAmount(row.Item_Price || '0');
            let orderPrice: number | null = null;
            if (policyVersion === 2) orderPrice = finiteAmount(row.Order_Price);
            else if (row.Order_Price.trim()) {
              try { orderPrice = finiteAmount(row.Order_Price); } catch { /* Keep the attempt with an explicitly invalid total. */ }
            }
            const item: ReceiptItem = {
              name: row.Item_Name,
              quantity,
              price: policyVersion === 2 ? linePrice / quantity : 0,
              customizations: row.Customizations
                ? row.Customizations.split(',').map((value) => value.trim()).filter(Boolean)
                : [],
            };
            const group = results.get(orderKey);
            if (group) {
              if (group.items.length >= MAX_ITEMS_PER_ORDER) throw new ValidationError('An order contains too many items', 'file');
              group.items.push(item);
              group.rows.push(row);
              if (orderPrice !== null) group.maxOrderPrice = Math.max(group.maxOrderPrice ?? orderPrice, orderPrice);
            } else {
              if (results.size >= MAX_CSV_ORDERS) {
                stream.destroy();
                reject(new ValidationError('CSV exceeds the maximum order count', 'file'));
                return;
              }
              results.set(orderKey, { first: row, rows: [row], items: [item], maxOrderPrice: orderPrice });
            }
          } catch (error) {
            invalidRows += 1;
            return;
          }
        })
        .on('end', () => {
          try {
            if (exceedsInvalidRowBudget(invalidRows, rowCount)) {
              reject(new ValidationError('CSV contains too many malformed rows', 'file'));
              return;
            }
            // Check if we have any valid data rows
            if (rowCount === 0) {
              // File only has headers, no data rows (account with no orders)
              resolve({
                success: false,
                rejectedRecords: 0,
                totalOrders: 0,
                totalReceipts: 0,
                totalAmount: 0,
                errors: [
                  'CSV file contains no valid order data. All rows are missing required fields (Restaurant_Name, Request_Time_Local) or have invalid values.',
                ],
                receipts: [],
              });
              return;
            }

            if (results.size === 0) {
              // File has rows but none are valid (all incomplete/refunded or missing required fields)
              resolve({
                success: false,
                rejectedRecords: invalidRows + [...unsupportedStatusRows.values()].reduce((sum, count) => sum + count, 0),
                ...(policyVersion === 3 ? { statusCounts: {}, unsupportedStatusRows: Object.fromEntries(unsupportedStatusRows) } : {}),
                totalOrders: 0,
                totalReceipts: 0,
                totalAmount: 0,
                errors: [
                  'CSV file contains no valid order data. All rows are missing required fields (Restaurant_Name, Request_Time_Local) or have invalid values.',
                ],
                receipts: [],
              });
              return;
            }

            const receipts = this.convertUberEatsRowsToReceipts(results, userId, timezone, policyVersion);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
            const statusCounts: Partial<Record<FulfillmentStatus, number>> = {};
            if (policyVersion === 3) for (const receipt of receipts) {
              const status = receipt.resolution?.orderEvidence?.fulfillment ?? 'unknown';
              statusCounts[status] = (statusCounts[status] ?? 0) + 1;
            }

            resolve({
              success: errors.length === 0,
              totalOrders: receipts.length,
              totalReceipts: receipts.length,
              rejectedRecords: invalidRows + [...unsupportedStatusRows.values()].reduce((sum,n) => sum+n, 0) + results.size - receipts.length,
              ...(policyVersion === 3 ? { statusCounts, unsupportedStatusRows: Object.fromEntries(unsupportedStatusRows) } : {}),
              totalAmount,
              errors,
              receipts,
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Parse DoorDash CSV file and convert to Receipt objects
   */
  async parseDoorDashCsv(csvBuffer: Buffer | Readable, userId: string, timezone = getDefaultTimezone(), policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY): Promise<ImportResult> {
    const results = new Map<string, DoorDashOrderGroup>();
    const errors: string[] = [];
    let rowCount = 0;
    let invalidRows = 0;

    return new Promise((resolve, reject) => {
      const stream = Buffer.isBuffer(csvBuffer) ? Readable.from(csvBuffer.toString()) : csvBuffer;

      stream
        .pipe(csv(parserOptions))
        .on('data', (value: unknown) => {
          rowCount++;
          if (rowCount > MAX_CSV_ROWS) {
            stream.destroy();
            reject(new ValidationError('CSV exceeds the maximum row count', 'file'));
            return;
          }
          try {
            const row = decodeDoorDashCsvRow(value);
            // Validate required fields (check for empty strings after trimming)
            row.STORE_NAME = boundedText(row.STORE_NAME, MAX_TEXT.merchant);
            row.ITEM = boundedText(row.ITEM, MAX_TEXT.item);
            row.CATEGORY = boundedText(row.CATEGORY, MAX_TEXT.category);
            row.DELIVERY_ADDRESS = boundedText(row.DELIVERY_ADDRESS, MAX_TEXT.address);
            const storeName = row.STORE_NAME?.trim();
            const createdAt = row.CREATED_AT?.trim();
            if (!storeName || !createdAt) {
              invalidRows += 1;
              return;
            }

            // Validate subtotal
            const subtotal = policyVersion === 3 && !row.SUBTOTAL.trim() ? null : finiteAmount(row.SUBTOTAL);

            // Validate UNIT_PRICE is a valid number (catches malformed CSV rows)
            if (policyVersion === 3 && !row.UNIT_PRICE.trim()) throw new ValidationError('DoorDash item price is missing', 'file');
            const unitPrice = finiteAmount(row.UNIT_PRICE);

            const orderKey = `${row.STORE_NAME}-${row.CREATED_AT}-${row.DELIVERY_TIME}`;
            const item: ReceiptItem = {
              name: row.ITEM,
              quantity: finiteQuantity(row.QUANTITY),
              price: unitPrice,
              category: row.CATEGORY,
            };
            const group = results.get(orderKey);
            if (group) {
              if (group.items.length >= MAX_ITEMS_PER_ORDER) throw new ValidationError('An order contains too many items', 'file');
              group.items.push(item);
              group.rows.push(row);
              group.subtotal = group.subtotal === null || subtotal === null ? null : moneySum([group.subtotal, subtotal]);
            } else {
              if (results.size >= MAX_CSV_ORDERS) {
                stream.destroy();
                reject(new ValidationError('CSV exceeds the maximum order count', 'file'));
                return;
              }
              results.set(orderKey, { first: row, rows: [row], items: [item], subtotal });
            }
          } catch (error) {
            invalidRows += 1;
            return;
          }
        })
        .on('end', () => {
          try {
            if (exceedsInvalidRowBudget(invalidRows, rowCount)) {
              reject(new ValidationError('CSV contains too many malformed rows', 'file'));
              return;
            }
            // Check if we have any valid data rows
            if (rowCount === 0) {
              // File only has headers, no data rows
              resolve({
                success: false,
                rejectedRecords: 0,
                totalOrders: 0,
                totalReceipts: 0,
                totalAmount: 0,
                errors: [
                  'CSV file contains only headers with no order data. Please ensure your DoorDash data export includes completed orders.',
                ],
                receipts: [],
              });
              return;
            }

            if (results.size === 0) {
              // File has rows but none are valid
              resolve({
                success: false,
                rejectedRecords: invalidRows,
                totalOrders: 0,
                totalReceipts: 0,
                totalAmount: 0,
                errors: [
                  'CSV file contains no valid order data. All rows are missing required fields (STORE_NAME, CREATED_AT, SUBTOTAL) or have invalid values.',
                ],
                receipts: [],
              });
              return;
            }

            const { receipts, rejectedRecords } = this.convertDoorDashRowsToReceipts(results, userId, timezone, policyVersion);
            if (policyVersion === 3 && rejectedRecords > 0)
              errors.push(`${rejectedRecords} DoorDash source rows could not produce valid order evidence`);
            const statusCounts: Partial<Record<FulfillmentStatus, number>> = {};
            if (policyVersion === 3) for (const receipt of receipts) {
              const status = receipt.resolution!.orderEvidence!.fulfillment;
              statusCounts[status] = (statusCounts[status] ?? 0) + 1;
            }
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

            resolve({
              success: errors.length === 0,
              totalOrders: results.size,
              totalReceipts: receipts.length,
              rejectedRecords: invalidRows + rejectedRecords,
              ...(policyVersion === 3 ? { statusCounts } : {}),
              totalAmount,
              errors,
              receipts,
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Convert DoorDash CSV rows to Receipt objects
   * Groups items by order (same store, same created_at, same delivery_time)
   */
  private convertDoorDashRowsToReceipts(orderGroups: Map<string, DoorDashOrderGroup>, userId: string, timezone: string, policyVersion: ReceiptPolicyVersion) {
    const receipts: Receipt[] = [];
    let rejectedRecords = 0;

    for (const group of orderGroups.values()) {
      const firstRow = group.first;
      const currencies = group.rows.map((row) => exportAddressCurrency(row.DELIVERY_ADDRESS));
      const knownCurrencies = new Set(currencies.filter((c) => c.currencyCode !== 'UNKNOWN').map((c) => c.currencyCode));
      if (policyVersion === 3 && knownCurrencies.size > 1) {
        rejectedRecords += group.rows.length;
        this.logRejectedOrder('doordash', 'conflicting_currency');
        continue;
      }
      const currency = policyVersion === 3
        ? currencies.filter((c) => c.currencyCode !== 'UNKNOWN').sort((a, b) => (a.currencyInference ?? '').localeCompare(b.currencyInference ?? ''))[0] ?? { currencyCode: 'UNKNOWN' as const }
        : exportAddressCurrency(firstRow.DELIVERY_ADDRESS);
      const facts = policyVersion === 3 ? doorDashExportEvidence(firstRow.CREATED_AT, firstRow.DELIVERY_TIME, timezone, { earliest: MIN_ORDER_DATE, latest: Date.now() + 86_400_000 }) : undefined;

      // Parse order date (CREATED_AT is when order was placed)
      let orderDate: Date | undefined = facts?.orderDate;
      if (policyVersion === 2 && firstRow.CREATED_AT) {
        try {
          const parsedDate = this.parseDoorDashTimestamp(firstRow.CREATED_AT, timezone);
          if (!isNaN(parsedDate.getTime()) && safeDate(parsedDate)) {
            orderDate = parsedDate;
          } else {
            this.logRejectedOrder('doordash', 'invalid_order_date');
          }
        } catch (error) {
          this.logRejectedOrder('doordash', 'invalid_order_date', error);
        }
      }

      // Parse delivery time (DELIVERY_TIME is when order was delivered)
      let deliveryTime: Date | undefined = facts?.deliveryTime;
      if (policyVersion === 2 && firstRow.DELIVERY_TIME) {
        try {
          const parsedTime = this.parseDoorDashTimestamp(firstRow.DELIVERY_TIME, timezone);
          if (!isNaN(parsedTime.getTime()) && safeDate(parsedTime)) {
            deliveryTime = parsedTime;
          } else {
            this.logRejectedOrder('doordash', 'invalid_delivery_time');
          }
        } catch (error) {
          this.logRejectedOrder('doordash', 'invalid_delivery_time', error);
        }
      }

      // Calculate order total by summing SUBTOTAL
      const orderTotal = group.subtotal;

      if (orderTotal !== null && (isNaN(orderTotal) || orderTotal < 0)) {
        rejectedRecords += group.rows.length;
        this.logRejectedOrder('doordash', 'invalid_order_total');
        continue;
      }

      // Skip orders without valid CREATED_AT (required field)
      if (!orderDate) {
        rejectedRecords += group.rows.length;
        this.logRejectedOrder('doordash', 'missing_order_date');
        continue;
      }

      // Skip orders without valid STORE_NAME (required field)
      if (!firstRow.STORE_NAME || !firstRow.STORE_NAME.trim()) {
        rejectedRecords += group.rows.length;
        this.logRejectedOrder('doordash', 'missing_store_name');
        continue;
      }

      // Convert items
      // Create receipt
      const receipt = new Receipt(
        userId,
        group.items,
        orderTotal ?? 0,
        ReceiptType.DOORDASH, // Set receipt_type to DOORDASH
        firstRow.STORE_NAME,
        orderDate,
        DataSource.CSV, // dataSource
        deliveryTime, // delivery_time for wait time analytics
        undefined,
        undefined,
        { ...(group.subtotal === null ? {} : { subtotal: group.subtotal }), currencyCode: currency.currencyCode },
        { version: 1, amountBasis: 'item_subtotal', currencyInference: currency.currencyInference,
          ...(facts ? { orderEvidence: { ...facts.evidence, issues: [...facts.evidence.issues, ...(group.subtotal === null ? ['Item subtotal is incomplete'] : [])] } } : {}),
          ...(group.subtotal === null ? {} : { reconstructedSubtotal: group.subtotal }),
          adjustments: [], issues: ['Final charge is not supplied by this export', ...(group.subtotal === null ? ['Item subtotal is incomplete'] : []), currency.currencyInference ? 'Currency inferred from delivery-address evidence' : 'Currency is not supplied by this export'],
          rows: group.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'DELIVERY_ADDRESS'))),
          timestamp: { raw: firstRow.CREATED_AT, deliveryRaw: firstRow.DELIVERY_TIME, role: 'placed', timezone, convention: 'explicit offset, otherwise account timezone', ...(facts ? { precision: facts.precision } : {}) } },
      );

      receipts.push(receipt);
    }

    return { receipts, rejectedRecords };
  }

  /**
   * Convert Uber Eats CSV rows to Receipt objects
   * Groups items by order (same restaurant, same time)
   * Note: All items in the same order should have the same Order_Price, but we group by restaurant + time
   * to handle any data inconsistencies where Order_Price might vary
   */
  private convertUberEatsRowsToReceipts(
    orderGroups: Map<string, UberOrderGroup>,
    userId: string,
    timezone: string,
    policyVersion: 2 | 3 = 2,
  ): Receipt[] {
    const receipts: Receipt[] = [];
    const priceBasis = createUberItemPriceResolver([...orderGroups.values()].map(group => ({
      merchant: group.first.Restaurant_Name,
      currency: group.first.Currency,
      orderDate: group.first.Request_Time_Local,
      rows: group.rows,
    })));

    for (const group of orderGroups.values()) {
      const firstRow = group.first;
      const eventTimezone = exportCityTimezone(firstRow.City_Name, firstRow.Currency, timezone);

      // Parse order date
      let orderDate: Date | undefined;
      const parsedOrderDate = this.parseUberLocalTimestamp(firstRow.Request_Time_Local, eventTimezone);
      if (parsedOrderDate && safeDate(parsedOrderDate)) {
        orderDate = parsedOrderDate;
      } else {
        this.logRejectedOrder('uber_eats', 'invalid_order_date');
      }

      // Parse delivery time (Final_Delivery_Time_Local is when order was delivered)
      let deliveryTime: Date | undefined;
      if (firstRow.Final_Delivery_Time_Local) {
        const parsedDeliveryTime = this.parseUberLocalTimestamp(
          firstRow.Final_Delivery_Time_Local,
          eventTimezone,
        );
        if (parsedDeliveryTime && safeDate(parsedDeliveryTime)) {
          deliveryTime = parsedDeliveryTime;
        } else {
          this.logRejectedOrder('uber_eats', 'invalid_delivery_time');
        }
      }

      // Require a valid exported total; conflicting values are retained and resolved below.
      if (!orderDate) continue;
      if (policyVersion === 2 && group.maxOrderPrice === null) {
        this.logRejectedOrder('uber_eats', 'invalid_order_total');
        continue;
      }
      const totals = new Map<number, number>();
      for (const row of group.rows) {
        if (!row.Order_Price.trim()) continue;
        try { const value = finiteAmount(row.Order_Price); totals.set(value, (totals.get(value) ?? 0) + 1); } catch { /* Raw invalid values remain in source rows. */ }
      }
      const reportedTotal = [...totals].sort(([a, ac], [b, bc]) => bc - ac || a - b)[0]?.[0] ?? null;
      const statuses = [...new Set(group.rows.map(row => row.Order_Status.trim().toLowerCase().replace('cancelled', 'canceled')))];
      const status = statuses.length === 1 && (statuses[0] === 'completed' || statuses[0] === 'canceled' || statuses[0] === 'failed' || statuses[0] === 'unfulfilled') ? statuses[0] : 'unknown';
      const itemRows = policyVersion === 3 ? group.rows.filter(row => row.Item_Name) : group.rows;
      const priceDocument = { merchant: firstRow.Restaurant_Name, currency: firstRow.Currency, orderDate: firstRow.Request_Time_Local };
      const items = policyVersion === 2
        ? group.items
        : itemRows.length
          ? reconstructUberItems(itemRows, undefined, false, 'per_item', row => priceBasis(priceDocument, row))
          : [];
      const pricesResolved = items.every(item => item.evidence?.priceResolution?.status !== 'ambiguous');
      const orderEvidence: OrderSourceEvidence = {
        version: 1, parserVersion: CURRENT_UBER_EXPORT_PARSER_VERSION, documentKind: 'export', fulfillment: status, rawStatus: statuses.join('|'),
        timestamps: [{ role: 'placed', raw: firstRow.Request_Time_Local, instant: orderDate.toISOString(), precision: 'second' },
          ...(deliveryTime ? [{ role: status === 'completed' ? 'delivered' as const : 'ended' as const, raw: firstRow.Final_Delivery_Time_Local, instant: deliveryTime.toISOString(), precision: 'second' as const }] : [])],
        recordedTotal: totals.size > 1 ? null : reportedTotal,
        totalState: totals.size > 1 ? 'invalid' : reportedTotal !== null ? 'known' : group.rows.some(row => row.Order_Price.trim()) ? 'invalid' : 'blank',
        payments: [], issues: [...(totals.size > 1 ? ['Conflicting repeated export totals'] : []), ...(statuses.length > 1 ? ['Conflicting export statuses'] : [])],
      };
      // Mode preserves the most-repeated source value; ties stay deterministic, never highest-wins.
      const receipt = new Receipt(
        userId,
        items,
        // Compatibility scalar only. Policy-3 readers use nullable orderOutcome.netAmount.
        reportedTotal ?? 0,
        ReceiptType.UBER_EATS, // Set receipt_type to UBER_EATS
        firstRow.Restaurant_Name,
        orderDate,
        DataSource.CSV, // dataSource
        policyVersion === 3 && status !== 'completed' ? undefined : deliveryTime,
        undefined,
        undefined,
        {
          currencyCode: ['CAD', 'USD', 'EUR', 'GBP'].includes(firstRow.Currency.trim().toUpperCase())
            ? firstRow.Currency.trim().toUpperCase() as 'CAD' | 'USD' | 'EUR' | 'GBP'
            : 'UNKNOWN',
        },
        { version: 1, amountBasis: 'export_total', ...(reportedTotal === null ? {} : { exportedTotal: reportedTotal }),
          ...(policyVersion === 3 ? { orderEvidence } : {}),
          ...(pricesResolved ? { reconstructedSubtotal: moneySum(items.map(item => item.evidence?.configuredLineTotal ?? item.quantity * item.price)) } : {}),
          adjustments: [], issues: ['Export total is not a verified final charge', ...(!pricesResolved ? ['Some item prices could not be interpreted safely'] : []), ...(totals.size > 1 ? ['Conflicting export totals retained; selected modal amount'] : [])],
          rows: group.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'Special_Instructions'))),
          timestamp: { raw: firstRow.Request_Time_Local, deliveryRaw: firstRow.Final_Delivery_Time_Local, role: 'placed', ...(policyVersion === 3 ? { precision: 'minute' as const } : {}), timezone: eventTimezone, convention: 'Uber Local wall time; currency-scoped city or account timezone inference' } },
      );

      receipts.push(receipt);
    }

    return receipts;
  }

  /**
   * Uber labels these fields *_Local. Some exports append "Z" even though the
   * values are local wall time, so parsing with new Date() shifts every order.
   */
  private parseUberLocalTimestamp(value: string, timezone: string): Date | null {
    if (/[+-]\d{2}:?\d{2}$/.test(value.trim())) return new Date(value);
    const match = value
      ?.trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/);
    if (!match) return null;
    return zonedDateTimeToUtc(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
      },
      timezone,
    );
  }

  private parseDoorDashTimestamp(value: string, timezone: string): Date {
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return new Date(value);
    const normalized = value.trim().replace(' ', 'T');
    return this.parseUberLocalTimestamp(normalized, timezone) ?? new Date(NaN);
  }

  private logRejectedOrder(
    provider: 'uber_eats' | 'doordash',
    reason: string,
    error?: unknown,
  ): void {
    this.logger.warn('Export order row rejected', {
      operation: 'csv_receipt_extraction',
      provider,
      outcome: 'row_rejected',
      reason,
      error,
    });
  }

  /**
   * Validate CSV file format (supports both Uber Eats and DoorDash)
   */
  validateCsvFormat(csvBuffer: Buffer): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (csvBuffer.length >= MAX_HEADER_BYTES && !csvBuffer.includes(0x0a)) return { valid: false, errors: ['CSV header exceeds the safe size limit'] };
    const content = csvBuffer.toString('utf8').replace(/^\uFEFF/, '');
    if (content.includes('\u0000')) return { valid: false, errors: ['CSV contains invalid binary data'] };

    // Check if it's a valid CSV
    if (!content.includes(',')) {
      errors.push('File does not appear to be a valid CSV');
      return { valid: false, errors };
    }

    const firstLine = content.split(/\r?\n/, 1)[0];
    const headers = readCsvHeaders(firstLine).map((header) => header.toLowerCase());
    if (headers.length > MAX_CSV_COLUMNS) return { valid: false, errors: ['CSV contains too many columns'] };
    if (new Set(headers).size !== headers.length) return { valid: false, errors: ['CSV contains duplicate headers'] };
    const format = this.detectCsvFormat(Buffer.from(firstLine));

    if (format === 'doordash') {
      // Check for DoorDash order required headers
      const requiredHeaders = [
        'item',
        'store_name',
        'created_at',
        'subtotal',
        'quantity',
        'unit_price',
      ];

      for (const header of requiredHeaders) {
        if (!headers.includes(header)) {
          errors.push(`Missing required DoorDash header: ${header}`);
        }
      }
    } else if (format === 'uber') {
      // Check for Uber Eats required headers
      const requiredHeaders = [
        'restaurant_name',
        'request_time_local',
        'order_status',
        'item_name',
        'item_quantity',
        'item_price',
        'order_price',
      ];

      for (const header of requiredHeaders) {
        if (!headers.includes(header)) {
          errors.push(`Missing required Uber Eats header: ${header}`);
        }
      }
    } else {
      errors.push('Unknown CSV format. Expected Uber Eats or DoorDash format.');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private async readHeaderSample(filePath: string): Promise<Buffer> {
    const handle = await open(filePath, 'r');
    try {
      const sample = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      return sample.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
