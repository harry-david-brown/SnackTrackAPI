import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { PostgresService } from '../data/PostgresService';
import { v4 as uuidv4 } from 'uuid';

export interface ReceiptFilters {
  userId?: string;
  receiptType?: ReceiptType;
  restaurantName?: string;
  startDate?: Date;
  endDate?: Date;
  minAmount?: number;
  maxAmount?: number;
}

export interface ReceiptAnalytics {
  totalSpent: number;
  totalOrders: number;
  averageOrderValue: number;
  topRestaurants: Array<{ name: string; count: number; totalSpent: number }>;
  spendingByType: Array<{ type: string; count: number; totalSpent: number }>;
  spendingByMonth: Array<{ month: string; totalSpent: number; orderCount: number }>;
}

export class ReceiptService {
  constructor(private postgres: PostgresService) { }

  // CREATE - Add a new receipt
  async createReceipt(receipt: Receipt): Promise<string> {
    const receiptId = uuidv4();

    // Truncate restaurant name to fit VARCHAR(255) constraint
    const truncatedRestaurantName = receipt.restaurantName
      ? receipt.restaurantName.substring(0, 255)
      : receipt.restaurantName;

    if (receipt.restaurantName && receipt.restaurantName.length > 255) {
      console.warn(`⚠️  Restaurant name truncated from ${receipt.restaurantName.length} to 255 chars: ${receipt.restaurantName.substring(0, 50)}...`);
    }

    await this.postgres.query(`
      INSERT INTO receipts (
        id, user_id, receipt_type, data_source, restaurant_name, order_date, 
        amount_spent, items, delivery_time, external_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      receiptId,
      receipt.userId,
      receipt.receiptType,
      receipt.dataSource,
      truncatedRestaurantName,
      receipt.orderDate,
      receipt.amountSpent,
      JSON.stringify(receipt.items),
      receipt.deliveryTime || null,
      receipt.externalId || null
    ]);

    return receiptId;
  }

  /**
   * CREATE BATCH - Add multiple receipts in a single database transaction
   * Uses batch inserts for 10-20x performance improvement over individual inserts
   * Automatically handles duplicates using ON CONFLICT for receipts with external_id
   * 
   * @param receipts Array of receipts to insert
   * @returns Array of inserted receipt IDs
   */
  async createReceiptsBatch(receipts: Receipt[]): Promise<string[]> {
    if (receipts.length === 0) return [];

    const insertedIds: string[] = [];
    const batchSize = 50; // Optimal batch size for PostgreSQL

    console.log(`📦 Batch inserting ${receipts.length} receipts (batch size: ${batchSize})...`);
    const startTime = Date.now();

    for (let i = 0; i < receipts.length; i += batchSize) {
      const batch = receipts.slice(i, i + batchSize);
      const values: any[] = [];
      const placeholders: string[] = [];

      batch.forEach((receipt, index) => {
        const id = uuidv4();
        insertedIds.push(id);

        // Truncate restaurant name to fit VARCHAR(255) constraint
        const truncatedRestaurantName = receipt.restaurantName
          ? receipt.restaurantName.substring(0, 255)
          : receipt.restaurantName;

        // Calculate parameter indices (10 params per receipt)
        const p = index * 10 + 1;
        placeholders.push(
          `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, $${p + 9})`
        );

        values.push(
          id,
          receipt.userId,
          receipt.receiptType,
          receipt.dataSource,
          truncatedRestaurantName,
          receipt.orderDate,
          receipt.amountSpent,
          JSON.stringify(receipt.items),
          receipt.deliveryTime || null,
          receipt.externalId || null
        );
      });

      try {
        // Use ON CONFLICT to handle duplicates for receipts with external_id
        // If a duplicate is found, update to the higher amount (handles tip updates)
        await this.postgres.query(`
          INSERT INTO receipts (
            id, user_id, receipt_type, data_source, restaurant_name, order_date, 
            amount_spent, items, delivery_time, external_id
          ) VALUES ${placeholders.join(', ')}
          ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL
          DO UPDATE SET 
            amount_spent = GREATEST(receipts.amount_spent, EXCLUDED.amount_spent),
            updated_at = CURRENT_TIMESTAMP
        `, values);
      } catch (error: any) {
        console.error(`❌ Batch insert failed for batch ${Math.floor(i / batchSize) + 1}:`, error.message);
        throw error;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Batch inserted ${receipts.length} receipts in ${duration}s`);

    return insertedIds;
  }

  // READ - Get receipts with filters
  async getReceipts(filters: ReceiptFilters = {}, limit: number = 50, offset: number = 0): Promise<Receipt[]> {
    let query = `
      SELECT * FROM receipts 
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramCount = 0;

    if (filters.userId) {
      paramCount++;
      query += ` AND user_id = $${paramCount}`;
      params.push(filters.userId);
    }

    if (filters.receiptType) {
      paramCount++;
      query += ` AND receipt_type = $${paramCount}`;
      params.push(filters.receiptType);
    }

    if (filters.restaurantName) {
      paramCount++;
      query += ` AND restaurant_name ILIKE $${paramCount}`;
      params.push(`%${filters.restaurantName}%`);
    }

    if (filters.startDate) {
      paramCount++;
      query += ` AND order_date >= $${paramCount}`;
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      paramCount++;
      query += ` AND order_date <= $${paramCount}`;
      params.push(filters.endDate);
    }

    if (filters.minAmount) {
      paramCount++;
      query += ` AND amount_spent >= $${paramCount}`;
      params.push(filters.minAmount);
    }

    if (filters.maxAmount) {
      paramCount++;
      query += ` AND amount_spent <= $${paramCount}`;
      params.push(filters.maxAmount);
    }

    query += ` ORDER BY order_date DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await this.postgres.query(query, params);
    return result.rows.map(this.mapRowToReceipt);
  }

  // READ - Get a single receipt by ID
  async getReceiptById(id: string): Promise<Receipt | null> {
    const result = await this.postgres.query(
      'SELECT * FROM receipts WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToReceipt(result.rows[0]);
  }

  // UPDATE - Update a receipt
  async updateReceipt(id: string, updates: Partial<Receipt>): Promise<boolean> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 0;

    // Build dynamic update query
    if (updates.restaurantName !== undefined) {
      paramCount++;
      fields.push(`restaurant_name = $${paramCount}`);
      values.push(updates.restaurantName);
    }

    if (updates.amountSpent !== undefined) {
      paramCount++;
      fields.push(`amount_spent = $${paramCount}`);
      values.push(updates.amountSpent);
    }

    // Note: subtotal, tax, tip, deliveryFee, serviceFee removed from simplified model
    // Uncomment if these fields are added back to Receipt model
    // if ((updates as any).subtotal !== undefined) {
    //   paramCount++;
    //   fields.push(`subtotal = $${paramCount}`);
    //   values.push((updates as any).subtotal);
    // }

    // if ((updates as any).tax !== undefined) {
    //   paramCount++;
    //   fields.push(`tax = $${paramCount}`);
    //   values.push((updates as any).tax);
    // }

    // if ((updates as any).tip !== undefined) {
    //   paramCount++;
    //   fields.push(`tip = $${paramCount}`);
    //   values.push((updates as any).tip);
    // }

    // if ((updates as any).deliveryFee !== undefined) {
    //   paramCount++;
    //   fields.push(`delivery_fee = $${paramCount}`);
    //   values.push((updates as any).deliveryFee);
    // }

    // if ((updates as any).serviceFee !== undefined) {
    //   paramCount++;
    //   fields.push(`service_fee = $${paramCount}`);
    //   values.push((updates as any).serviceFee);
    // }

    if (updates.items !== undefined) {
      paramCount++;
      fields.push(`items = $${paramCount}`);
      values.push(JSON.stringify(updates.items));
    }

    if (fields.length === 0) {
      return false; // No fields to update
    }

    paramCount++;
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `UPDATE receipts SET ${fields.join(', ')} WHERE id = $${paramCount}`;
    const result = await this.postgres.query(query, values);

    return result.rowCount > 0;
  }

  // DELETE - Delete a receipt
  async deleteReceipt(id: string): Promise<boolean> {
    const result = await this.postgres.query(
      'DELETE FROM receipts WHERE id = $1',
      [id]
    );

    return result.rowCount > 0;
  }

  // ANALYTICS - Get spending analytics for a user
  async getReceiptAnalytics(userId: string, startDate?: Date, endDate?: Date): Promise<ReceiptAnalytics> {
    let dateFilter = '';
    const params: any[] = [userId];
    let paramCount = 1;

    if (startDate) {
      paramCount++;
      dateFilter += ` AND order_date >= $${paramCount}`;
      params.push(startDate);
    }

    if (endDate) {
      paramCount++;
      dateFilter += ` AND order_date <= $${paramCount}`;
      params.push(endDate);
    }

    // Get basic stats - only count actual receipts (amount_spent > 0)
    const statsResult = await this.postgres.query(`
      SELECT 
        COALESCE(SUM(amount_spent), 0) as total_spent,
        COUNT(*) as total_orders,
        COALESCE(AVG(amount_spent), 0) as average_order_value
      FROM receipts 
      WHERE user_id = $1 AND amount_spent > 0 ${dateFilter}
    `, params);

    const stats = statsResult.rows[0];

    // Get top restaurants - only actual receipts
    const restaurantsResult = await this.postgres.query(`
      SELECT 
        restaurant_name,
        COUNT(*) as count,
        SUM(amount_spent) as total_spent
      FROM receipts 
      WHERE user_id = $1 AND restaurant_name IS NOT NULL AND amount_spent > 0 ${dateFilter}
      GROUP BY restaurant_name
      ORDER BY total_spent DESC
      LIMIT 10
    `, params);

    // Get spending by type - only actual receipts
    const typesResult = await this.postgres.query(`
      SELECT 
        receipt_type,
        COUNT(*) as count,
        SUM(amount_spent) as total_spent
      FROM receipts 
      WHERE user_id = $1 AND amount_spent > 0 ${dateFilter}
      GROUP BY receipt_type
      ORDER BY total_spent DESC
    `, params);

    // Get spending by month - only actual receipts
    const monthsResult = await this.postgres.query(`
      SELECT 
        TO_CHAR(order_date, 'YYYY-MM') as month,
        SUM(amount_spent) as total_spent,
        COUNT(*) as order_count
      FROM receipts 
      WHERE user_id = $1 AND order_date IS NOT NULL AND amount_spent > 0 ${dateFilter}
      GROUP BY TO_CHAR(order_date, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT 12
    `, params);

    return {
      totalSpent: parseFloat(stats.total_spent),
      totalOrders: parseInt(stats.total_orders),
      averageOrderValue: parseFloat(stats.average_order_value),
      topRestaurants: restaurantsResult.rows.map((row: any) => ({
        name: row.restaurant_name,
        count: parseInt(row.count),
        totalSpent: parseFloat(row.total_spent)
      })),
      spendingByType: typesResult.rows.map((row: any) => ({
        type: row.receipt_type,
        count: parseInt(row.count),
        totalSpent: parseFloat(row.total_spent)
      })),
      spendingByMonth: monthsResult.rows.map((row: any) => ({
        month: row.month,
        totalSpent: parseFloat(row.total_spent),
        orderCount: parseInt(row.order_count)
      }))
    };
  }

  // Helper method to map database row to Receipt object
  private mapRowToReceipt(row: any): Receipt {
    // Handle both old and new item formats
    let items: ReceiptItem[] = [];
    if (row.items) {
      try {
        // Try to parse as JSON first (new format)
        if (typeof row.items === 'string') {
          items = JSON.parse(row.items);
        } else if (Array.isArray(row.items)) {
          // Handle old TEXT[] format - convert to ReceiptItem format
          items = row.items.map((item: any) => {
            // If item is a string, convert to ReceiptItem
            if (typeof item === 'string') {
              return {
                name: item,
                quantity: 1,
                price: 0
              };
            }
            // If item is already an object, ensure it has required properties
            return {
              name: item?.name || 'Unknown item',
              quantity: typeof item?.quantity === 'number' ? item.quantity : 1,
              price: typeof item?.price === 'number' ? item.price : 0
            };
          });
        } else {
          items = row.items;
        }
      } catch (error) {
        console.error('Error parsing receipt items:', error);
        // If parsing fails, treat as empty array
        items = [];
      }
    }

    // Ensure items is always an array
    if (!Array.isArray(items)) {
      items = [];
    }

    return new Receipt(
      row.user_id,
      items,
      parseFloat(row.amount_spent || 0),
      (row.receipt_type as ReceiptType) || ReceiptType.UNKNOWN,
      row.restaurant_name,
      row.order_date ? new Date(row.order_date) : undefined,
      (row.data_source as DataSource) || DataSource.CSV,
      row.delivery_time ? new Date(row.delivery_time) : undefined,
      row.external_id || undefined
    );
  }
}
