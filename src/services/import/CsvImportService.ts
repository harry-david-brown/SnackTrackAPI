import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { v4 as uuidv4 } from 'uuid';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { getDefaultTimezone, zonedDateTimeToUtc } from '../../utils/timezone';
import { silentStructuredLogger, StructuredLogger } from '../core/StructuredLogger';

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
    const firstLine = content.split('\n')[0].toLowerCase();

    // Check for DoorDash order headers
    if (
      firstLine.includes('item') &&
      firstLine.includes('store_name') &&
      firstLine.includes('created_at') &&
      firstLine.includes('subtotal')
    ) {
      return 'doordash';
    }

    // Check for DoorDash profile headers (consumer_profile_details.csv)
    // This file is sent when account has no orders yet
    if (
      firstLine.includes('first_name') &&
      firstLine.includes('last_name') &&
      firstLine.includes('email') &&
      firstLine.includes('phone_number')
    ) {
      return 'doordash';
    }

    // Check for Uber Eats headers
    if (
      firstLine.includes('restaurant_name') &&
      firstLine.includes('request_time_local') &&
      firstLine.includes('order_price') &&
      firstLine.includes('item_name')
    ) {
      return 'uber';
    }

    return 'unknown';
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
    csvBuffer: Buffer,
    userId: string,
    timezone: string = getDefaultTimezone(),
  ): Promise<ImportResult> {
    const results: UberCsvRow[] = [];
    const errors: string[] = [];
    let rowCount = 0;

    return new Promise((resolve, reject) => {
      const stream = Readable.from(csvBuffer.toString());

      stream
        .pipe(csv())
        .on('data', (value: unknown) => {
          rowCount++;
          try {
            const row = decodeUberCsvRow(value);
            // Validate required fields (Order_Price can be empty for refunded orders)
            if (!row.Restaurant_Name || !row.Request_Time_Local) {
              // Skip rows with missing required fields (likely empty/invalid rows)
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

            results.push(row);
          } catch (error) {
            // Skip rows that cause parsing errors
            return;
          }
        })
        .on('end', () => {
          try {
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

            if (results.length === 0) {
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
              totalOrders: this.getUniqueUberEatsOrderCount(results),
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
  async parseDoorDashCsv(csvBuffer: Buffer, userId: string): Promise<ImportResult> {
    const results: DoorDashCsvRow[] = [];
    const errors: string[] = [];
    let rowCount = 0;

    return new Promise((resolve, reject) => {
      const stream = Readable.from(csvBuffer.toString());

      stream
        .pipe(csv())
        .on('data', (value: unknown) => {
          rowCount++;
          try {
            const row = decodeDoorDashCsvRow(value);
            // Validate required fields (check for empty strings after trimming)
            const storeName = row.STORE_NAME?.trim();
            const createdAt = row.CREATED_AT?.trim();
            if (!storeName || !createdAt) {
              // Skip rows with missing required fields (likely empty/invalid rows)
              return;
            }

            // Validate subtotal
            const subtotal = parseFloat(row.SUBTOTAL);
            if (isNaN(subtotal) || subtotal < 0) {
              // Skip rows with invalid subtotals
              return;
            }

            // Validate UNIT_PRICE is a valid number (catches malformed CSV rows)
            const unitPrice = parseFloat(row.UNIT_PRICE);
            if (isNaN(unitPrice) || unitPrice < 0) {
              // Skip rows with invalid unit prices (likely malformed CSV)
              return;
            }

            results.push(row);
          } catch (error) {
            // Skip rows that cause parsing errors
            return;
          }
        })
        .on('end', () => {
          try {
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

            if (results.length === 0) {
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
              totalOrders: this.getUniqueDoorDashOrderCount(results),
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
  private convertDoorDashRowsToReceipts(rows: DoorDashCsvRow[], userId: string): Receipt[] {
    // Group rows by order (store + created_at + delivery_time)
    const orderGroups = new Map<string, DoorDashCsvRow[]>();

    for (const row of rows) {
      const orderKey = `${row.STORE_NAME}-${row.CREATED_AT}-${row.DELIVERY_TIME}`;

      if (!orderGroups.has(orderKey)) {
        orderGroups.set(orderKey, []);
      }
      orderGroups.get(orderKey)!.push(row);
    }

    const receipts: Receipt[] = [];

    for (const [orderKey, orderRows] of orderGroups) {
      const firstRow = orderRows[0];

      // Parse order date (CREATED_AT is when order was placed)
      let orderDate: Date | undefined;
      if (firstRow.CREATED_AT) {
        try {
          const parsedDate = new Date(firstRow.CREATED_AT);
          if (!isNaN(parsedDate.getTime())) {
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
          if (!isNaN(parsedTime.getTime())) {
            deliveryTime = parsedTime;
          } else {
            this.logRejectedOrder('doordash', 'invalid_delivery_time');
          }
        } catch (error) {
          this.logRejectedOrder('doordash', 'invalid_delivery_time', error);
        }
      }

      // Calculate order total by summing SUBTOTAL
      const orderTotal = orderRows.reduce((sum, row) => {
        const subtotal = parseFloat(row.SUBTOTAL) || 0;
        return sum + subtotal;
      }, 0);

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
      const items: ReceiptItem[] = orderRows.map((row) => ({
        name: row.ITEM,
        quantity: parseInt(row.QUANTITY) || 1,
        price: parseFloat(row.UNIT_PRICE) || 0,
        category: row.CATEGORY, // Store category for potential analytics
      }));

      // Create receipt
      const receipt = new Receipt(
        userId,
        items,
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
   * Get count of unique DoorDash orders
   */
  private getUniqueDoorDashOrderCount(rows: DoorDashCsvRow[]): number {
    const uniqueOrders = new Set<string>();

    for (const row of rows) {
      const orderKey = `${row.STORE_NAME}-${row.CREATED_AT}-${row.DELIVERY_TIME}`;
      uniqueOrders.add(orderKey);
    }

    return uniqueOrders.size;
  }

  /**
   * Convert Uber Eats CSV rows to Receipt objects
   * Groups items by order (same restaurant, same time)
   * Note: All items in the same order should have the same Order_Price, but we group by restaurant + time
   * to handle any data inconsistencies where Order_Price might vary
   */
  private convertUberEatsRowsToReceipts(
    rows: UberCsvRow[],
    userId: string,
    timezone: string,
  ): Receipt[] {
    // Group rows by order (restaurant + time only)
    // All items in the same order should be grouped together regardless of Order_Price value
    const orderGroups = new Map<string, UberCsvRow[]>();

    for (const row of rows) {
      const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}`;

      if (!orderGroups.has(orderKey)) {
        orderGroups.set(orderKey, []);
      }
      orderGroups.get(orderKey)!.push(row);
    }

    const receipts: Receipt[] = [];

    for (const [orderKey, orderRows] of orderGroups) {
      const firstRow = orderRows[0];

      // Parse order date
      let orderDate: Date | undefined;
      const parsedOrderDate = this.parseUberLocalTimestamp(firstRow.Request_Time_Local, timezone);
      if (parsedOrderDate) {
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
        if (parsedDeliveryTime) {
          deliveryTime = parsedDeliveryTime;
        } else {
          this.logRejectedOrder('uber_eats', 'invalid_delivery_time');
        }
      }

      // Parse order price - use the maximum Order_Price from all rows in case of inconsistencies
      // All rows should have the same Order_Price, but we take max to handle any data issues
      const orderPrices = orderRows
        .map((row) => parseFloat(row.Order_Price))
        .filter((p) => !isNaN(p));
      if (orderPrices.length === 0) {
        this.logRejectedOrder('uber_eats', 'invalid_order_total');
        continue;
      }
      const orderPrice = Math.max(...orderPrices); // Use max price as order total

      // Convert items
      const items: ReceiptItem[] = orderRows.map((row) => {
        const quantity = Math.max(1, parseInt(row.Item_quantity, 10) || 1);
        const linePrice = parseFloat(row.Item_Price) || 0;
        return {
          name: row.Item_Name,
          quantity,
          // Uber's Item_Price is the full line price (for example quantity 2
          // at $16.99 is exported as $33.98). ReceiptItem.price is per unit.
          price: linePrice / quantity,
          customizations: row.Customizations
            ? row.Customizations.split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
        };
      });

      // Create receipt
      const receipt = new Receipt(
        userId,
        items,
        orderPrice,
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

  /**
   * Get count of unique Uber Eats orders
   * Counts by restaurant + time (not price) to match receipt grouping
   */
  private getUniqueUberEatsOrderCount(rows: UberCsvRow[]): number {
    const uniqueOrders = new Set<string>();

    for (const row of rows) {
      // Count unique orders by restaurant + time (matching receipt grouping)
      const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}`;
      uniqueOrders.add(orderKey);
    }

    return uniqueOrders.size;
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
    const content = csvBuffer.toString();

    // Check if it's a valid CSV
    if (!content.includes(',')) {
      errors.push('File does not appear to be a valid CSV');
      return { valid: false, errors };
    }

    const format = this.detectCsvFormat(csvBuffer);
    const firstLine = content.split('\n')[0].toLowerCase();

    if (format === 'doordash') {
      // Check if it's a profile file (no order data) or order file
      const isProfileFile =
        firstLine.includes('first_name') &&
        firstLine.includes('last_name') &&
        firstLine.includes('email');

      if (isProfileFile) {
        // Profile file is valid DoorDash format, but will have no orders
        // Let it through validation - parser will handle "no orders" case
        return { valid: true, errors: [] };
      }

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
        if (!firstLine.includes(header)) {
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
        if (!firstLine.includes(header)) {
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
}
