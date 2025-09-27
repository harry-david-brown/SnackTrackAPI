import { Receipt } from '../../models/Receipt';
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
    await this.postgres.query(`
      INSERT INTO receipts (
        user_id, receipt_type, restaurant_name, order_date, 
        amount_spent, subtotal, tax, tip, delivery_fee, service_fee,
        items, email_from, email_to, email_subject, email_body
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
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
      receipt.items.length > 0 ? JSON.stringify(receipt.items) : null,
      receipt.emailFrom,
      receipt.emailTo,
      receipt.emailSubject,
      receipt.emailBody
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
    return new Receipt(
      row.user_id,
      row.items ? (typeof row.items === 'string' ? JSON.parse(row.items) : row.items) : [],
      parseFloat(row.amount_spent),
      row.receipt_type,
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
