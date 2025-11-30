import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { PostgresService } from '../data/PostgresService';
import { v4 as uuidv4 } from 'uuid';
import csv from 'csv-parser';
import { Readable } from 'stream';

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

export interface ImportResult {
  success: boolean;
  totalOrders: number;
  totalReceipts: number;
  totalAmount: number;
  errors: string[];
  receipts: Receipt[];
}

export class CsvImportService {
  constructor(private postgres: PostgresService) {}

  /**
   * Detect CSV format (Uber Eats or DoorDash)
   */
  detectCsvFormat(csvBuffer: Buffer): 'uber' | 'doordash' | 'unknown' {
    const content = csvBuffer.toString();
    const firstLine = content.split('\n')[0].toLowerCase();

    // Check for DoorDash headers
    if (firstLine.includes('item') && 
        firstLine.includes('store_name') && 
        firstLine.includes('created_at') &&
        firstLine.includes('subtotal')) {
      return 'doordash';
    }

    // Check for Uber Eats headers
    if (firstLine.includes('restaurant_name') && 
        firstLine.includes('request_time_local') && 
        firstLine.includes('order_price') &&
        firstLine.includes('item_name')) {
      return 'uber';
    }

    return 'unknown';
  }

  /**
   * Parse CSV file and convert to Receipt objects
   * Auto-detects format and routes to appropriate parser
   */
  async parseCsvFile(csvBuffer: Buffer, userId: string): Promise<ImportResult> {
    const format = this.detectCsvFormat(csvBuffer);

    if (format === 'doordash') {
      return this.parseDoorDashCsv(csvBuffer, userId);
    } else if (format === 'uber') {
      return this.parseUberEatsCsv(csvBuffer, userId);
    } else {
      throw new Error('Unknown CSV format. Expected Uber Eats or DoorDash format.');
    }
  }

  /**
   * Parse Uber Eats CSV file and convert to Receipt objects
   */
  async parseUberEatsCsv(csvBuffer: Buffer, userId: string): Promise<ImportResult> {
    const results: UberCsvRow[] = [];
    const errors: string[] = [];
    
    return new Promise((resolve, reject) => {
      const stream = Readable.from(csvBuffer.toString());
      
      stream
        .pipe(csv())
        .on('data', (row: UberCsvRow) => {
          try {
            // Validate required fields (Order_Price can be empty for refunded orders)
            if (!row.Restaurant_Name || !row.Request_Time_Local) {
              errors.push(`Invalid row: Missing required fields - ${JSON.stringify(row)}`);
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
            errors.push(`Error parsing row: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        })
        .on('end', () => {
          try {
            const receipts = this.convertUberEatsRowsToReceipts(results, userId);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
            
            resolve({
              success: errors.length === 0,
              totalOrders: this.getUniqueUberEatsOrderCount(results),
              totalReceipts: receipts.length,
              totalAmount,
              errors,
              receipts
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
    
    return new Promise((resolve, reject) => {
      const stream = Readable.from(csvBuffer.toString());
      
      stream
        .pipe(csv())
        .on('data', (row: DoorDashCsvRow) => {
          try {
            // Validate required fields
            if (!row.STORE_NAME || !row.CREATED_AT) {
              errors.push(`Invalid row: Missing required fields - ${JSON.stringify(row)}`);
              return;
            }

            // Validate subtotal
            const subtotal = parseFloat(row.SUBTOTAL);
            if (isNaN(subtotal) || subtotal < 0) {
              errors.push(`Invalid subtotal: ${row.SUBTOTAL}`);
              return;
            }
            
            results.push(row);
          } catch (error) {
            errors.push(`Error parsing row: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        })
        .on('end', () => {
          try {
            const receipts = this.convertDoorDashRowsToReceipts(results, userId);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
            
            resolve({
              success: errors.length === 0,
              totalOrders: this.getUniqueDoorDashOrderCount(results),
              totalReceipts: receipts.length,
              totalAmount,
              errors,
              receipts
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
      try {
        orderDate = new Date(firstRow.CREATED_AT);
      } catch (error) {
        console.warn(`Invalid date format: ${firstRow.CREATED_AT}`);
      }

      // Parse delivery time (DELIVERY_TIME is when order was delivered)
      let deliveryTime: Date | undefined;
      try {
        deliveryTime = new Date(firstRow.DELIVERY_TIME);
      } catch (error) {
        console.warn(`Invalid delivery time format: ${firstRow.DELIVERY_TIME}`);
      }

      // Calculate order total by summing SUBTOTAL
      const orderTotal = orderRows.reduce((sum, row) => {
        const subtotal = parseFloat(row.SUBTOTAL) || 0;
        return sum + subtotal;
      }, 0);

      if (isNaN(orderTotal) || orderTotal <= 0) {
        console.warn(`Invalid order total for order: ${orderKey}`);
        continue;
      }

      // Convert items
      const items: ReceiptItem[] = orderRows.map(row => ({
        name: row.ITEM,
        quantity: parseInt(row.QUANTITY) || 1,
        price: parseFloat(row.UNIT_PRICE) || 0,
        category: row.CATEGORY // Store category for potential analytics
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
        deliveryTime // delivery_time for wait time analytics
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
  private convertUberEatsRowsToReceipts(rows: UberCsvRow[], userId: string): Receipt[] {
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
      try {
        orderDate = new Date(firstRow.Request_Time_Local);
      } catch (error) {
        console.warn(`Invalid date format: ${firstRow.Request_Time_Local}`);
      }

      // Parse order price - use the maximum Order_Price from all rows in case of inconsistencies
      // All rows should have the same Order_Price, but we take max to handle any data issues
      const orderPrices = orderRows.map(row => parseFloat(row.Order_Price)).filter(p => !isNaN(p));
      if (orderPrices.length === 0) {
        console.warn(`No valid order price found for order: ${firstRow.Restaurant_Name} at ${firstRow.Request_Time_Local}`);
        continue;
      }
      const orderPrice = Math.max(...orderPrices); // Use max price as order total

      // Convert items
      const items: ReceiptItem[] = orderRows.map(row => ({
        name: row.Item_Name,
        quantity: parseInt(row.Item_quantity) || 1,
        price: parseFloat(row.Item_Price) || 0
      }));

      // Create receipt
      const receipt = new Receipt(
        userId,
        items,
        orderPrice,
        ReceiptType.UBER_EATS, // Set receipt_type to UBER_EATS
        firstRow.Restaurant_Name,
        orderDate,
        DataSource.CSV // dataSource
      );

      receipts.push(receipt);
    }

    return receipts;
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

  /**
   * Import receipts to database
   */
  async importReceipts(receipts: Receipt[], userId: string): Promise<void> {
    // Clear existing receipts for this user to avoid duplicates
    await this.postgres.query('DELETE FROM receipts WHERE user_id = $1', [userId]);
    
    for (const receipt of receipts) {
      // Use the userId parameter to ensure consistency (receipt.userId should match, but use parameter for safety)
      // This ensures receipts are always associated with the correct user, even if receipt.userId is somehow incorrect
      await this.postgres.query(`
        INSERT INTO receipts (
          user_id, receipt_type, data_source, restaurant_name, order_date, 
          amount_spent, items, delivery_time
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        userId, // Use the userId parameter, not receipt.userId, to ensure consistency
        receipt.receiptType,
        receipt.dataSource,
        receipt.restaurantName,
        receipt.orderDate,
        receipt.amountSpent,
        receipt.items.length > 0 ? JSON.stringify(receipt.items) : '[]',
        receipt.deliveryTime || null
      ]);
    }
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
      // Check for DoorDash required headers
      const requiredHeaders = [
        'item',
        'store_name',
        'created_at',
        'subtotal',
        'quantity',
        'unit_price'
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
        'order_price'
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
      errors
    };
  }
}
