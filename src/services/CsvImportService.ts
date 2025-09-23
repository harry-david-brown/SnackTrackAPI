import { Receipt, ReceiptType, ReceiptItem } from '../models/Receipt';
import { PostgresService } from './PostgresService';
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
   * Parse CSV file and convert to Receipt objects
   */
  async parseCsvFile(csvBuffer: Buffer, userId: string): Promise<ImportResult> {
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
            const receipts = this.convertCsvRowsToReceipts(results, userId);
            const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
            
            resolve({
              success: errors.length === 0,
              totalOrders: this.getUniqueOrderCount(results),
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
   * Convert CSV rows to Receipt objects
   * Groups items by order (same restaurant, same time, same order price)
   */
  private convertCsvRowsToReceipts(rows: UberCsvRow[], userId: string): Receipt[] {
    // Group rows by order (restaurant + time + order price)
    const orderGroups = new Map<string, UberCsvRow[]>();
    
    for (const row of rows) {
      const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}-${row.Order_Price}`;
      
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

      // Parse order price
      const orderPrice = parseFloat(firstRow.Order_Price);
      if (isNaN(orderPrice)) {
        console.warn(`Invalid order price: ${firstRow.Order_Price}`);
        continue;
      }

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
        ReceiptType.UBER_EATS,
        firstRow.Restaurant_Name,
        orderDate,
        'uber-csv-import', // emailFrom
        userId, // emailTo
        `Uber Eats Order from ${firstRow.Restaurant_Name}`, // emailSubject
        `CSV Import: ${orderRows.length} items`, // emailBody
        orderPrice, // subtotal
        0, // tax (not available in CSV)
        0, // tip (not available in CSV)
        0, // deliveryFee (not available in CSV)
        0  // serviceFee (not available in CSV)
      );

      receipts.push(receipt);
    }

    return receipts;
  }

  /**
   * Get count of unique orders
   */
  private getUniqueOrderCount(rows: UberCsvRow[]): number {
    const uniqueOrders = new Set<string>();
    
    for (const row of rows) {
      const orderKey = `${row.Restaurant_Name}-${row.Request_Time_Local}-${row.Order_Price}`;
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
    
    // Insert new receipts
    for (const receipt of receipts) {
      await this.postgres.query(`
        INSERT INTO receipts (
          user_id, receipt_type, restaurant_name, order_date, 
          amount_spent, subtotal, tax, tip, delivery_fee, service_fee,
          items, email_from, email_to, email_subject, email_body
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        userId,
        receipt.receiptType,
        receipt.restaurantName,
        receipt.orderDate,
        receipt.amountSpent,
        receipt.subtotal,
        receipt.tax,
        receipt.tip,
        receipt.deliveryFee,
        receipt.serviceFee,
        receipt.items,
        receipt.emailFrom,
        receipt.emailTo,
        receipt.emailSubject,
        receipt.emailBody
      ]);
    }
  }

  /**
   * Validate CSV file format
   */
  validateCsvFormat(csvBuffer: Buffer): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const content = csvBuffer.toString();
    
    // Check if it's a valid CSV
    if (!content.includes(',')) {
      errors.push('File does not appear to be a valid CSV');
      return { valid: false, errors };
    }

    // Check for required headers
    const requiredHeaders = [
      'City_Name',
      'Restaurant_Name', 
      'Request_Time_Local',
      'Order_Status',
      'Item_Name',
      'Item_quantity',
      'Item_Price',
      'Order_Price',
      'Currency'
    ];

    const firstLine = content.split('\n')[0];
    for (const header of requiredHeaders) {
      if (!firstLine.includes(header)) {
        errors.push(`Missing required header: ${header}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
