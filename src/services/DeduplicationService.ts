/**
 * Abstract Deduplication Service
 * 
 * Provides the interface for deduplication logic across different data sources.
 * This is designed to be implemented when we have multiple data sources.
 */

import { Receipt } from '../models/Receipt';
import { DataSourcePriority, getDataSourcePriority, hasHigherPriority } from '../config/DataSourcePriority';

export interface DuplicateMatch {
  receipt1: Receipt;
  receipt2: Receipt;
  confidence: number;  // 0-1 confidence score
  matchReason: string; // Why these receipts are considered duplicates
}

export interface DeduplicationResult {
  duplicates: DuplicateMatch[];
  keptReceipts: Receipt[];
  archivedReceipts: Receipt[];
  totalProcessed: number;
}

export abstract class DeduplicationService {
  /**
   * Find potential duplicates between receipts from different sources
   */
  abstract findDuplicates(receipts: Receipt[]): DuplicateMatch[];

  /**
   * Resolve duplicates by keeping the higher priority source
   */
  abstract resolveDuplicates(duplicates: DuplicateMatch[]): DeduplicationResult;

  /**
   * Archive receipts from lower priority sources when higher priority data is available
   */
  abstract archiveLowerPriorityReceipts(
    receipts: Receipt[], 
    highestPrioritySource: string
  ): { kept: Receipt[]; archived: Receipt[] };

  /**
   * Check if two receipts are likely duplicates
   */
  protected abstract areReceiptsDuplicate(receipt1: Receipt, receipt2: Receipt): boolean;

  /**
   * Calculate confidence score for duplicate match
   */
  protected abstract calculateConfidence(receipt1: Receipt, receipt2: Receipt): number;

  /**
   * Get the reason why receipts are considered duplicates
   */
  protected abstract getMatchReason(receipt1: Receipt, receipt2: Receipt): string;
}

/**
 * Concrete implementation for current CSV-only system
 * This will be extended when we add financial aggregators and email parsing
 */
export class CsvDeduplicationService extends DeduplicationService {
  findDuplicates(receipts: Receipt[]): DuplicateMatch[] {
    // For now, CSV is the only source, so no duplicates possible
    // This will be implemented when we have multiple data sources
    return [];
  }

  resolveDuplicates(duplicates: DuplicateMatch[]): DeduplicationResult {
    // CSV always wins, so just return the CSV receipts
    return {
      duplicates: [],
      keptReceipts: [],
      archivedReceipts: [],
      totalProcessed: 0
    };
  }

  archiveLowerPriorityReceipts(
    receipts: Receipt[], 
    highestPrioritySource: string
  ): { kept: Receipt[]; archived: Receipt[] } {
    // For CSV-only system, keep all receipts
    return {
      kept: receipts,
      archived: []
    };
  }

  protected areReceiptsDuplicate(receipt1: Receipt, receipt2: Receipt): boolean {
    // Placeholder implementation
    // Will be implemented with fuzzy matching logic
    return false;
  }

  protected calculateConfidence(receipt1: Receipt, receipt2: Receipt): number {
    // Placeholder implementation
    // Will calculate confidence based on matching criteria
    return 0;
  }

  protected getMatchReason(receipt1: Receipt, receipt2: Receipt): string {
    // Placeholder implementation
    // Will provide human-readable reason for duplicate match
    return '';
  }
}
