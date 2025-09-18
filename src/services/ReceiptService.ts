import { Receipt, ReceiptType, ReceiptItem } from '../models/Receipt';
import { PostgresService } from './PostgresService';
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
  constructor(private postgres: PostgresService) {}

  // CREATE - Add a new receipt
  async createReceipt(receipt: Receipt): Promise<string> {
    const receiptId = uuidv4();
    
    await this.postgres.query(`
      INSERT INTO receipts (
        id, user_id, receipt_type, restaurant_name, order_date, 
        amount_spent, subtotal, tax, tip, delivery_fee, service_fee,
        items, email_from, email_to, email_subject, email_body
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [
      receiptId,
      receipt.userId,
      receipt.receiptType,
      receipt.restaurantName,
      receipt.orderDate,
      receipt.amountSpent,
      receipt.subtotal,
      receipt.tax,
      receipt.tip,
      receipt.deliveryFee,
      receipt.serviceFee,
      JSON.stringify(receipt.items),
      receipt.emailFrom,
      receipt.emailTo,
      receipt.emailSubject,
      receipt.emailBody
    ]);

    return receiptId;
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

    query += ` ORDER BY order_date DESC, created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
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

    if (updates.subtotal !== undefined) {
      paramCount++;
      fields.push(`subtotal = $${paramCount}`);
      values.push(updates.subtotal);
    }

    if (updates.tax !== undefined) {
      paramCount++;
      fields.push(`tax = $${paramCount}`);
      values.push(updates.tax);
    }

    if (updates.tip !== undefined) {
      paramCount++;
      fields.push(`tip = $${paramCount}`);
      values.push(updates.tip);
    }

    if (updates.deliveryFee !== undefined) {
      paramCount++;
      fields.push(`delivery_fee = $${paramCount}`);
      values.push(updates.deliveryFee);
    }

    if (updates.serviceFee !== undefined) {
      paramCount++;
      fields.push(`service_fee = $${paramCount}`);
      values.push(updates.serviceFee);
    }

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
    let items: any[] = [];
    if (row.items) {
      try {
        // Try to parse as JSON first (new format)
        if (typeof row.items === 'string') {
          items = JSON.parse(row.items);
        } else if (Array.isArray(row.items)) {
          // Handle old TEXT[] format - convert to ReceiptItem format
          items = row.items.map((item: string) => ({
            name: item,
            quantity: 1,
            price: 0
          }));
        } else {
          items = row.items;
        }
      } catch (error) {
        // If parsing fails, treat as empty array
        items = [];
      }
    }

    return new Receipt(
      row.user_id,
      items,
      parseFloat(row.amount_spent || 0),
      (row.receipt_type as ReceiptType) || ReceiptType.UNKNOWN,
      row.restaurant_name,
      row.order_date ? new Date(row.order_date) : undefined,
      row.email_from,
      row.email_to,
      row.email_subject,
      row.email_body,
      row.subtotal ? parseFloat(row.subtotal) : undefined,
      row.tax ? parseFloat(row.tax) : undefined,
      row.tip ? parseFloat(row.tip) : undefined,
      row.delivery_fee ? parseFloat(row.delivery_fee) : undefined,
      row.service_fee ? parseFloat(row.service_fee) : undefined
    );
  }
}
