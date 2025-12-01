import { Receipt, DataSource } from '../../models/Receipt';
import { PostgresService } from './PostgresService';

/**
 * Repository for receipt data access operations
 * Separated from DatabaseService to follow single responsibility principle
 */
export class ReceiptRepository {
  constructor(private postgres: PostgresService) {}

  async findByUserId(userId: string): Promise<Receipt[]> {
    const result = await this.postgres.query(
      'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC',
      [userId]
    );
    return result.rows.map(this.mapRowToReceipt);
  }

  async getTotalSpentByUserId(userId: string): Promise<number> {
    const result = await this.postgres.query(
      'SELECT COALESCE(SUM(amount_spent), 0) as total FROM receipts WHERE user_id = $1',
      [userId]
    );
    return parseFloat(result.rows[0].total);
  }

  async save(receipt: Receipt): Promise<void> {
    // Truncate restaurant name to fit VARCHAR(255) constraint
    const truncatedRestaurantName = receipt.restaurantName 
      ? receipt.restaurantName.substring(0, 255)
      : receipt.restaurantName;

    await this.postgres.query(`
      INSERT INTO receipts (
        user_id, receipt_type, data_source, restaurant_name, order_date, 
        amount_spent, items, delivery_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      receipt.userId,
      receipt.receiptType,
      receipt.dataSource,
      truncatedRestaurantName,
      receipt.orderDate,
      receipt.amountSpent,
      receipt.items.length > 0 ? JSON.stringify(receipt.items) : '[]',
      receipt.deliveryTime || null
    ]);
  }

  async saveMany(receipts: Receipt[]): Promise<void> {
    for (const receipt of receipts) {
      await this.save(receipt);
    }
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.postgres.query('DELETE FROM receipts WHERE user_id = $1', [userId]);
  }

  async findByDateRange(userId: string, startDate: Date, endDate: Date): Promise<Receipt[]> {
    const result = await this.postgres.query(
      'SELECT * FROM receipts WHERE user_id = $1 AND order_date BETWEEN $2 AND $3 ORDER BY order_date DESC',
      [userId, startDate, endDate]
    );
    return result.rows.map(this.mapRowToReceipt);
  }

  private mapRowToReceipt(row: any): Receipt {
    const receipt = new Receipt(
      row.user_id,
      row.items ? (typeof row.items === 'string' ? JSON.parse(row.items) : row.items) : [],
      parseFloat(row.amount_spent),
      row.receipt_type,
      row.restaurant_name,
      row.order_date ? new Date(row.order_date) : undefined,
      row.data_source as DataSource || DataSource.CSV,
      row.delivery_time ? new Date(row.delivery_time) : undefined
    );
    
    // Set the ID for database responses
    (receipt as any).id = row.id;
    return receipt;
  }
}
