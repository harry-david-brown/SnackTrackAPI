/**
 * Receipt Matching Logic
 * 
 * Simple receipt matching for basic operations.
 * No complex duplicate detection - CSV data is the single source of truth.
 */

import { Receipt } from '../../models/Receipt';

export interface MatchResult {
  isMatch: boolean;
  confidence: number;
  reasons: string[];
}

export class ReceiptMatcher {
  /**
   * Simple restaurant name matching for basic operations
   */
  matchRestaurantNames(name1?: string, name2?: string): number {
    if (!name1 || !name2) return 0;
    
    const normalized1 = this.normalizeRestaurantName(name1);
    const normalized2 = this.normalizeRestaurantName(name2);
    
    // Exact match
    if (normalized1 === normalized2) return 1.0;
    
    // Contains match (one name contains the other)
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      return 0.9;
    }
    
    return 0;
  }

  /**
   * Simple amount matching with tolerance
   */
  matchAmounts(amount1: number, amount2: number): number {
    const diff = Math.abs(amount1 - amount2);
    const tolerance = Math.max(0.50, amount1 * 0.05); // $0.50 or 5% tolerance
    
    if (diff <= tolerance) return 1.0;
    if (diff <= tolerance * 2) return 0.8;
    
    return 0;
  }

  /**
   * Normalize restaurant name for comparison
   */
  private normalizeRestaurantName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();
  }
}