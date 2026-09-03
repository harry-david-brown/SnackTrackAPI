import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { v4 as uuidv4 } from 'uuid';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import { getDefaultTimezone, zonedDateTimeToUtc } from '../../utils/timezone';
import { silentStructuredLogger, StructuredLogger } from '../core/StructuredLogger';
import { ValidationError } from '../../core/errors';

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
  readonly items: ReceiptItem[];
  maxOrderPrice: number | null;
}

interface DoorDashOrderGroup {
  readonly first: DoorDashCsvRow;
  readonly items: ReceiptItem[];
  subtotal: number;
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

const boundedText = (value: string, maximum: number): string => {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
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
    const headers = new Set(content.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '').split(',').map((header) => header.trim().toLowerCase()));

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

  async parseCsvPath(filePath: string, userId: string, timezone?: string): Promise<ImportResult> {
    const format = await this.detectCsvFormatFromFile(filePath);
    if (format === 'doordash') return this.parseDoorDashCsv(createReadStream(filePath), userId);
    if (format === 'uber') {
      return this.parseUberEatsCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone());
    }
    throw new Error('Unknown CSV format. Expected Uber Eats or DoorDash format.');
  }

  async parseCsvPathForProvider(filePath: string, provider: 'uber_eats' | 'doordash', userId: string, timezone?: string): Promise<ImportResult> {
    return provider === 'uber_eats'
      ? this.parseUberEatsCsv(createReadStream(filePath), userId, timezone || getDefaultTimezone())
      : this.parseDoorDashCsv(createReadStream(filePath), userId);
  }

  /**
   * Parse CSV file and convert to Receipt objects
   * Auto-detects format and routes to appropriate parser
   */
  async parseCsvFile(csvBuffer: Buffer, userId: string, timezone?: string): Promise<ImportResult> {
    const format = this.detectCsvFormat(csvBuffer);

    if (format === 'doordash') {
      return this.parseDoorDashCsv(csvBuffer, userId);
    } else if (format === 'uber') {
      const userTimezone = timezone || getDefaultTimezone();
      return this.parseUberEatsCsv(csvBuffer, userId, userTimezone);
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
  ): Promise<ImportResult> {
    const results = new Map<string, UberOrderGroup>();
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
            const row = decodeUberCsvRow(value);
            // Validate required fields (Order_Price can be empty for refunded orders)
            row.Restaurant_Name = boundedText(row.Restaurant_Name, MAX_TEXT.merchant);
            row.Item_Name = boundedText(row.Item_Name, MAX_TEXT.item);
            row.Customizations = boundedText(row.Customizations, MAX_TEXT.customization);
            if (!row.Restaurant_Name || !row.Request_Time_Local) {
              invalidRows += 1;
              return;
            }

            // Handle empty Order_Price (refunded orders)
            if (!row.Order_Price || row.Order_Price === '') {
              row.Order_Price = '0.00'; // Set to 0 for refunded orders
            }

            // Only process completed orders
            if (row.Order_Status !== 'completed') {
              return;
            }

            const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}`;
            const quantity = finiteQuantity(row.Item_quantity);
            const linePrice = finiteAmount(row.Item_Price || '0');
            const orderPrice = finiteAmount(row.Order_Price);
            const item: ReceiptItem = {
              name: row.Item_Name,
              quantity,
              price: linePrice / quantity,
              customizations: row.Customizations
                ? row.Customizations.split(',').map((value) => value.trim()).filter(Boolean)
                : [],
            };
            const group = results.get(orderKey);
            if (group) {
              if (group.items.length >= MAX_ITEMS_PER_ORDER) throw new ValidationError('An order contains too many items', 'file');
              group.items.push(item);
              if (!Number.isNaN(orderPrice)) group.maxOrderPrice = Math.max(group.maxOrderPrice ?? orderPrice, orderPrice);
            } else {
              if (results.size >= MAX_CSV_ORDERS) {
                stream.destroy();
                reject(new ValidationError('CSV exceeds the maximum order count', 'file'));
                return;
              }
              results.set(orderKey, { first: row, items: [item], maxOrderPrice: orderPrice });
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

            const receipts = this.convertUberEatsRowsToReceipts(results, userId, timezone);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

            resolve({
              success: errors.length === 0,
              totalOrders: results.size,
              totalReceipts: receipts.length,
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
  async parseDoorDashCsv(csvBuffer: Buffer | Readable, userId: string): Promise<ImportResult> {
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
            const subtotal = finiteAmount(row.SUBTOTAL);

            // Validate UNIT_PRICE is a valid number (catches malformed CSV rows)
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
              group.subtotal += subtotal;
            } else {
              if (results.size >= MAX_CSV_ORDERS) {
                stream.destroy();
                reject(new ValidationError('CSV exceeds the maximum order count', 'file'));
                return;
              }
              results.set(orderKey, { first: row, items: [item], subtotal });
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

            const receipts = this.convertDoorDashRowsToReceipts(results, userId);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

            resolve({
              success: errors.length === 0,
              totalOrders: results.size,
              totalReceipts: receipts.length,
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
  private convertDoorDashRowsToReceipts(orderGroups: Map<string, DoorDashOrderGroup>, userId: string): Receipt[] {
    const receipts: Receipt[] = [];

    for (const group of orderGroups.values()) {
      const firstRow = group.first;

      // Parse order date (CREATED_AT is when order was placed)
      let orderDate: Date | undefined;
      if (firstRow.CREATED_AT) {
        try {
          const parsedDate = new Date(firstRow.CREATED_AT);
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
      let deliveryTime: Date | undefined;
      if (firstRow.DELIVERY_TIME) {
        try {
          const parsedTime = new Date(firstRow.DELIVERY_TIME);
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

      if (isNaN(orderTotal) || orderTotal <= 0) {
        this.logRejectedOrder('doordash', 'invalid_order_total');
        continue;
      }

      // Skip orders without valid CREATED_AT (required field)
      if (!orderDate) {
        this.logRejectedOrder('doordash', 'missing_order_date');
        continue;
      }

      // Skip orders without valid STORE_NAME (required field)
      if (!firstRow.STORE_NAME || !firstRow.STORE_NAME.trim()) {
        this.logRejectedOrder('doordash', 'missing_store_name');
        continue;
      }

      // Convert items
      // Create receipt
      const receipt = new Receipt(
        userId,
        group.items,
        orderTotal,
        ReceiptType.DOORDASH, // Set receipt_type to DOORDASH
        firstRow.STORE_NAME,
        orderDate,
        DataSource.CSV, // dataSource
        deliveryTime, // delivery_time for wait time analytics
      );

      receipts.push(receipt);
    }

    return receipts;
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
  ): Receipt[] {
    const receipts: Receipt[] = [];

    for (const group of orderGroups.values()) {
      const firstRow = group.first;

      // Parse order date
      let orderDate: Date | undefined;
      const parsedOrderDate = this.parseUberLocalTimestamp(firstRow.Request_Time_Local, timezone);
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
          timezone,
        );
        if (parsedDeliveryTime && safeDate(parsedDeliveryTime)) {
          deliveryTime = parsedDeliveryTime;
        } else {
          this.logRejectedOrder('uber_eats', 'invalid_delivery_time');
        }
      }

      // Parse order price - use the maximum Order_Price from all rows in case of inconsistencies
      // All rows should have the same Order_Price, but we take max to handle any data issues
      if (group.maxOrderPrice === null) {
        this.logRejectedOrder('uber_eats', 'invalid_order_total');
        continue;
      }
      // Create receipt
      const receipt = new Receipt(
        userId,
        group.items,
        group.maxOrderPrice,
        ReceiptType.UBER_EATS, // Set receipt_type to UBER_EATS
        firstRow.Restaurant_Name,
        orderDate,
        DataSource.CSV, // dataSource
        deliveryTime, // delivery_time for wait time analytics
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

    const firstLine = content.split(/\r?\n/, 1)[0].toLowerCase();
    const headers = firstLine.split(',').map((header) => header.trim());
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
