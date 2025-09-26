/**
 * Data Source Manager
 * 
 * Handles data source priority and deduplication logic.
 * This is the main orchestrator for managing multiple data sources.
 */

import { Receipt } from '../models/Receipt';
import { PostgresService } from './PostgresService';
import { DeduplicationService, CsvDeduplicationService } from './DeduplicationService';
import { ReceiptMatcher } from './ReceiptMatcher';
import { DataSourcePriority, getDataSourcePriority, hasHigherPriority, getHighestPrioritySource } from '../config/DataSourcePriority';

export interface DataSourceImportResult {
  source: string;
  receiptsImported: number;
  receiptsKept: number;
  receiptsArchived: number;
  duplicatesFound: number;
  totalAmount: number;
}

export class DataSourceManager {
  private postgres: PostgresService;
  private deduplicationService: DeduplicationService;
  private receiptMatcher: ReceiptMatcher;

  constructor(postgres: PostgresService) {
    this.postgres = postgres;
    this.deduplicationService = new CsvDeduplicationService();
    this.receiptMatcher = new ReceiptMatcher();
  }

  /**
   * Import receipts from a data source and handle deduplication
   */
  async importReceipts(
    userId: string, 
    source: string, 
    receipts: Receipt[]
  ): Promise<DataSourceImportResult> {
    const sourcePriority = getDataSourcePriority(source);
    
    // Get existing receipts for this user
    const existingReceipts = await this.getUserReceipts(userId);
    
    // Check if we need to archive existing receipts
    const shouldArchive = this.shouldArchiveExistingReceipts(existingReceipts, sourcePriority);
    
    if (shouldArchive) {
      await this.archiveLowerPriorityReceipts(userId, sourcePriority);
    }
    
    // Find duplicates between new receipts and existing ones
    const duplicates = this.findDuplicates(receipts, existingReceipts);
    
    // Filter out duplicate receipts
    const uniqueReceipts = receipts.filter(receipt => 
      !duplicates.some(dup => dup.receipt2 === receipt)
    );
    
    // Import unique receipts
    const importedCount = await this.importUniqueReceipts(userId, source, uniqueReceipts);
    
    // Mark duplicates in database
    await this.markDuplicates(duplicates);
    
    const totalAmount = uniqueReceipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
    
    return {
      source,
      receiptsImported: receipts.length,
      receiptsKept: uniqueReceipts.length,
      receiptsArchived: shouldArchive ? existingReceipts.length : 0,
      duplicatesFound: duplicates.length,
      totalAmount
    };
  }

  /**
   * Get all receipts for a user (excluding archived ones)
   */
  async getUserReceipts(userId: string): Promise<Receipt[]> {
    const result = await this.postgres.query(`
      SELECT * FROM receipts 
      WHERE user_id = $1 AND archived_at IS NULL
      ORDER BY created_at DESC
    `, [userId]);
    
    return result.rows.map((row: any) => this.mapRowToReceipt(row));
  }

  /**
   * Get the highest priority data source for a user
   */
  async getUserHighestPrioritySource(userId: string): Promise<string> {
    const result = await this.postgres.query(`
      SELECT DISTINCT data_source 
      FROM receipts 
      WHERE user_id = $1 AND archived_at IS NULL
    `, [userId]);
    
    const sources = result.rows.map((row: any) => row.data_source);
    return getHighestPrioritySource(sources);
  }

  /**
   * Check if user has data from a specific source
   */
  async hasDataSource(userId: string, source: string): Promise<boolean> {
    const result = await this.postgres.query(`
      SELECT COUNT(*) as count 
      FROM receipts 
      WHERE user_id = $1 AND data_source = $2 AND archived_at IS NULL
    `, [userId, source]);
    
    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Get data source statistics for a user
   */
  async getDataSourceStats(userId: string): Promise<Record<string, any>> {
    const result = await this.postgres.query(`
      SELECT 
        data_source,
        COUNT(*) as receipt_count,
        SUM(amount_spent) as total_amount,
        MIN(created_at) as earliest_import,
        MAX(created_at) as latest_import
      FROM receipts 
      WHERE user_id = $1 AND archived_at IS NULL
      GROUP BY data_source
      ORDER BY source_priority ASC
    `, [userId]);
    
    const stats: Record<string, any> = {};
    result.rows.forEach((row: any) => {
      stats[row.data_source] = {
        receiptCount: parseInt(row.receipt_count),
        totalAmount: parseFloat(row.total_amount),
        earliestImport: row.earliest_import,
        latestImport: row.latest_import,
        priority: getDataSourcePriority(row.data_source)
      };
    });
    
    return stats;
  }

  /**
   * Check if we should archive existing receipts based on new source priority
   */
  private shouldArchiveExistingReceipts(
    existingReceipts: Receipt[], 
    newSourcePriority: DataSourcePriority
  ): boolean {
    if (existingReceipts.length === 0) return false;
    
    // Get the highest priority of existing receipts
    const existingPriorities = existingReceipts.map(receipt => 
      getDataSourcePriority(receipt.emailFrom || 'csv')
    );
    const highestExistingPriority = Math.min(...existingPriorities);
    
    // Archive if new source has higher priority
    return newSourcePriority < highestExistingPriority;
  }

  /**
   * Archive receipts from lower priority sources
   */
  private async archiveLowerPriorityReceipts(
    userId: string, 
    newSourcePriority: DataSourcePriority
  ): Promise<void> {
    await this.postgres.query(`
      UPDATE receipts 
      SET archived_at = CURRENT_TIMESTAMP 
      WHERE user_id = $1 AND source_priority > $2 AND archived_at IS NULL
    `, [userId, newSourcePriority]);
  }

  /**
   * Find duplicates between new receipts and existing ones
   */
  private findDuplicates(newReceipts: Receipt[], existingReceipts: Receipt[]): Array<{receipt1: Receipt, receipt2: Receipt}> {
    const duplicates: Array<{receipt1: Receipt, receipt2: Receipt}> = [];
    
    for (const newReceipt of newReceipts) {
      for (const existingReceipt of existingReceipts) {
        const match = this.receiptMatcher.matchReceipts(newReceipt, existingReceipt);
        if (match.isMatch) {
          duplicates.push({ receipt1: existingReceipt, receipt2: newReceipt });
        }
      }
    }
    
    return duplicates;
  }

  /**
   * Import unique receipts to database
   */
  private async importUniqueReceipts(
    userId: string, 
    source: string, 
    receipts: Receipt[]
  ): Promise<number> {
    let importedCount = 0;
    
    for (const receipt of receipts) {
      await this.postgres.query(`
        INSERT INTO receipts (
          user_id, receipt_type, restaurant_name, order_date, 
          amount_spent, subtotal, tax, tip, delivery_fee, service_fee,
          items, email_from, email_to, email_subject, email_body,
          data_source, source_priority
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        receipt.emailBody,
        source,
        getDataSourcePriority(source)
      ]);
      importedCount++;
    }
    
    return importedCount;
  }

  /**
   * Mark duplicates in database
   */
  private async markDuplicates(duplicates: Array<{receipt1: Receipt, receipt2: Receipt}>): Promise<void> {
    // TODO: Implement when Receipt model has id field
    // for (const duplicate of duplicates) {
    //   const lowerPriorityReceipt = duplicate.receipt2;
    //   const higherPriorityReceipt = duplicate.receipt1;
    //   
    //   await this.postgres.query(`
    //     UPDATE receipts 
    //     SET is_duplicate = TRUE, duplicate_of = $1 
    //     WHERE id = $2
    //   `, [higherPriorityReceipt.id, lowerPriorityReceipt.id]);
    // }
  }

  /**
   * Map database row to Receipt object
   */
  private mapRowToReceipt(row: any): Receipt {
    return new Receipt(
      row.user_id,
      row.items || [],
      parseFloat(row.amount_spent),
      row.receipt_type,
      row.restaurant_name,
      row.order_date,
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
