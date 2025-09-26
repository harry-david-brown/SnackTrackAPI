/**
 * Receipt Matching Logic
 * 
 * Handles fuzzy matching between receipts from different data sources.
 * This will be crucial for detecting duplicates when we have multiple sources.
 */

import { Receipt } from '../models/Receipt';

export interface MatchingCriteria {
  restaurantNameWeight: number;
  orderDateWeight: number;
  totalAmountWeight: number;
  itemCountWeight: number;
  itemNamesWeight: number;
}

export interface MatchResult {
  isMatch: boolean;
  confidence: number;
  reasons: string[];
}

export class ReceiptMatcher {
  private criteria: MatchingCriteria;

  constructor(criteria?: Partial<MatchingCriteria>) {
    this.criteria = {
      restaurantNameWeight: 0.3,
      orderDateWeight: 0.25,
      totalAmountWeight: 0.2,
      itemCountWeight: 0.15,
      itemNamesWeight: 0.1,
      ...criteria
    };
  }

  /**
   * Check if two receipts are likely duplicates
   */
  matchReceipts(receipt1: Receipt, receipt2: Receipt): MatchResult {
    const reasons: string[] = [];
    let totalScore = 0;

    // Restaurant name matching
    const restaurantScore = this.matchRestaurantNames(
      receipt1.restaurantName, 
      receipt2.restaurantName
    );
    totalScore += restaurantScore * this.criteria.restaurantNameWeight;
    if (restaurantScore > 0.8) {
      reasons.push(`Restaurant names match: "${receipt1.restaurantName}" ≈ "${receipt2.restaurantName}"`);
    }

    // Order date matching
    const dateScore = this.matchOrderDates(receipt1.orderDate, receipt2.orderDate);
    totalScore += dateScore * this.criteria.orderDateWeight;
    if (dateScore > 0.8) {
      reasons.push(`Order dates match: ${receipt1.orderDate} ≈ ${receipt2.orderDate}`);
    }

    // Total amount matching
    const amountScore = this.matchAmounts(receipt1.amountSpent, receipt2.amountSpent);
    totalScore += amountScore * this.criteria.totalAmountWeight;
    if (amountScore > 0.8) {
      reasons.push(`Amounts match: $${receipt1.amountSpent} ≈ $${receipt2.amountSpent}`);
    }

    // Item count matching
    const itemCountScore = this.matchItemCounts(receipt1.items.length, receipt2.items.length);
    totalScore += itemCountScore * this.criteria.itemCountWeight;
    if (itemCountScore > 0.8) {
      reasons.push(`Item counts match: ${receipt1.items.length} ≈ ${receipt2.items.length}`);
    }

    // Item names matching
    const itemNamesScore = this.matchItemNames(receipt1.items, receipt2.items);
    totalScore += itemNamesScore * this.criteria.itemNamesWeight;
    if (itemNamesScore > 0.8) {
      reasons.push(`Item names match`);
    }

    return {
      isMatch: totalScore > 0.7, // Threshold for considering receipts as duplicates
      confidence: totalScore,
      reasons
    };
  }

  /**
   * Match restaurant names with fuzzy logic
   */
  private matchRestaurantNames(name1?: string, name2?: string): number {
    if (!name1 || !name2) return 0;
    
    const normalized1 = this.normalizeRestaurantName(name1);
    const normalized2 = this.normalizeRestaurantName(name2);
    
    // Exact match
    if (normalized1 === normalized2) return 1.0;
    
    // Contains match (one name contains the other)
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      return 0.9;
    }
    
    // Levenshtein distance for fuzzy matching
    const distance = this.levenshteinDistance(normalized1, normalized2);
    const maxLength = Math.max(normalized1.length, normalized2.length);
    const similarity = 1 - (distance / maxLength);
    
    return similarity > 0.8 ? similarity : 0;
  }

  /**
   * Match order dates with time tolerance
   */
  private matchOrderDates(date1?: Date, date2?: Date): number {
    if (!date1 || !date2) return 0;
    
    const diffMs = Math.abs(date1.getTime() - date2.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);
    
    // Same day
    if (diffHours < 24) return 1.0;
    
    // Within 1 hour (same order, different timestamps)
    if (diffHours < 1) return 0.95;
    
    // Within 2 hours
    if (diffHours < 2) return 0.8;
    
    return 0;
  }

  /**
   * Match amounts with tolerance
   */
  private matchAmounts(amount1: number, amount2: number): number {
    const diff = Math.abs(amount1 - amount2);
    const tolerance = Math.max(0.50, amount1 * 0.05); // $0.50 or 5% tolerance
    
    if (diff <= tolerance) return 1.0;
    if (diff <= tolerance * 2) return 0.8;
    if (diff <= tolerance * 3) return 0.6;
    
    return 0;
  }

  /**
   * Match item counts
   */
  private matchItemCounts(count1: number, count2: number): number {
    if (count1 === count2) return 1.0;
    if (Math.abs(count1 - count2) === 1) return 0.8;
    if (Math.abs(count1 - count2) <= 2) return 0.6;
    
    return 0;
  }

  /**
   * Match item names
   */
  private matchItemNames(items1: any[], items2: any[]): number {
    if (items1.length === 0 || items2.length === 0) return 0;
    
    const names1 = items1.map(item => item.name?.toLowerCase() || '');
    const names2 = items2.map(item => item.name?.toLowerCase() || '');
    
    let matches = 0;
    for (const name1 of names1) {
      for (const name2 of names2) {
        if (name1 === name2 || name1.includes(name2) || name2.includes(name1)) {
          matches++;
          break;
        }
      }
    }
    
    const maxItems = Math.max(items1.length, items2.length);
    return matches / maxItems;
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

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }
}
