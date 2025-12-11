import { User } from '../../models/User';
import { Receipt, ReceiptType, DataSource } from '../../models/Receipt';
import { GmailClient } from '../email/GmailClient';
import { ReceiptService } from '../receipt/ReceiptService';
import { PostgresService } from '../data/PostgresService';
import { cacheService } from '../core/CacheService';
import { ReceiptExtractor, RawEmail, ExtractionResult, ServiceType } from '../extraction';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';

export interface GmailImportResult {
  success: boolean;
  totalEmailsFound: number;
  totalReceiptsProcessed: number;
  totalReceiptsImported: number;
  totalAmount: number;
  errors: string[];
  receipts: Receipt[];
}

/**
 * Service to orchestrate importing Uber Eats receipts from Gmail
 * Uses existing email infrastructure to fetch, filter, and parse emails
 * 
 * Performance optimizations:
 * - Parallel email fetching from Gmail API
 * - Combined classification + extraction (no redundant classification)
 * - Parallel receipt parsing with concurrency limiting
 */
export class GmailImportService {
  private gmailClient: GmailClient;
  private extractor: ReceiptExtractor;
  private receiptService: ReceiptService;

  constructor(postgres: PostgresService) {
    this.gmailClient = new GmailClient();
    this.extractor = new ReceiptExtractor();
    this.receiptService = new ReceiptService(postgres);
  }

  /**
   * Import Uber Eats receipts from Gmail for a user
   * Always replaces existing email-based receipts before importing new ones
   * @param user User object with Gmail OAuth tokens
   * 
   * Performance optimizations:
   * - Parallel extraction with concurrency limiting (10 concurrent)
   * - Combined classification + extraction (single pass, no redundant work)
   */
  async importFromGmail(user: User): Promise<GmailImportResult> {
    const errors: string[] = [];
    const criticalErrors: string[] = []; // Errors that should mark import as failed

    try {
      // Validate user has Gmail connected
      if (!user.gmailRefreshToken) {
        throw new Error('User does not have Gmail connected');
      }

      // Fetch emails from Gmail (already parallelized in GmailClient)
      console.log(`📧 Fetching emails from Gmail for user: ${user.email}`);
      const emails = await this.gmailClient.getEmails(user);
      console.log(`📧 Found ${emails.length} emails from Gmail`);

      // OPTIMIZATION: Parallel extraction with combined classification + parsing
      // This eliminates redundant classification (previously done in filter AND parser)
      console.log(`🔄 Processing ${emails.length} emails in parallel...`);
      const parseStartTime = Date.now();
      
      // Limit concurrency to avoid memory issues with large batches
      const limit = pLimit(10);
      
      // Process all emails in parallel with single-pass extraction
      const extractionPromises = emails.map(email => 
        limit(async () => {
          const rawEmail: RawEmail = {
            userId: email.userId,
            from: email.from,
            to: email.to,
            body: email.body,
            subject: email.subject
          };
          
          // Single extraction call does both classification AND data extraction
          const result = this.extractor.extract(rawEmail);
          return { email, result };
        })
      );
      
      const extractionResults = await Promise.all(extractionPromises);
      const parseDuration = ((Date.now() - parseStartTime) / 1000).toFixed(2);
      console.log(`✅ Processed ${emails.length} emails in ${parseDuration}s`);

      // Separate receipts from non-receipts based on extraction results
      const receipts: Receipt[] = [];
      const emailReceiptPairs: Array<{ email: typeof emails[0], receipt: Receipt | null }> = [];
      let nonReceiptCount = 0;

      for (const { email, result } of extractionResults) {
        if (result.classification.isReceipt && result.data) {
          // Convert extraction result to Receipt
          const receipt = this.convertExtractionToReceipt(email.userId, result);
          if (receipt) {
            receipts.push(receipt);
            emailReceiptPairs.push({ email, receipt });
          } else {
            emailReceiptPairs.push({ email, receipt: null });
            // This is expected for non-receipt emails (Uber One, support emails, etc.)
            // Don't add to critical errors - these are informational only
            errors.push(`Failed to convert extraction for email from ${email.from}`);
          }
        } else {
          nonReceiptCount++;
          emailReceiptPairs.push({ email, receipt: null });
        }
      }

      console.log(`📧 Extracted ${receipts.length} receipts, skipped ${nonReceiptCount} non-receipt emails`);

      // Filter out non-food receipts (Uber rides, etc.) by checking receipt type
      const foodReceipts = receipts.filter(r => r.receiptType !== ReceiptType.UNKNOWN);
      const nonFoodCount = receipts.length - foodReceipts.length;

      if (nonFoodCount > 0) {
        console.log(`⏭️  Filtered out ${nonFoodCount} non-food receipts (Uber rides, etc.)`);

        // Save debug file for non-food receipts
        try {
          const nonFoodReceipts = emailReceiptPairs
            .filter(({ receipt }) => receipt && receipt.receiptType === ReceiptType.UNKNOWN)
            .map(({ email }) => ({
              userId: email.userId,
              from: email.from,
              to: email.to,
              subject: email.subject
              // body is intentionally excluded
            }));

          if (nonFoodReceipts.length > 0) {
            const debugDir = path.join(process.cwd(), 'debug-emails');
            if (!fs.existsSync(debugDir)) {
              fs.mkdirSync(debugDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const nonFoodFilename = `non-food-receipts-${user.id}-${timestamp}.json`;
            const nonFoodFilepath = path.join(debugDir, nonFoodFilename);

            fs.writeFileSync(nonFoodFilepath, JSON.stringify({
              userId: user.id,
              timestamp: new Date().toISOString(),
              count: nonFoodReceipts.length,
              emails: nonFoodReceipts
            }, null, 2));

            console.log(`🔍 DEBUG: Saved ${nonFoodReceipts.length} non-food receipts to ${nonFoodFilename}`);
          }
        } catch (debugError) {
          console.error('❌ Failed to create non-food-receipts debug file:', debugError);
        }
      }

      // Set default restaurant name for food receipts without one
      for (const receipt of foodReceipts) {
        if (!receipt.restaurantName || receipt.restaurantName === 'Unknown Restaurant') {
          receipt.restaurantName = 'Unknown Restaurant';
          console.log(`⚠️  Food receipt without restaurant name - setting to "Unknown Restaurant": $${receipt.amountSpent} on ${receipt.orderDate || 'unknown date'}`);
        }
      }

      const validReceipts = foodReceipts;
      console.log(`📧 ${validReceipts.length} food delivery receipts ready for import`);

      // Always delete existing email-based receipts BEFORE processing new ones
      // This ensures we replace all email-based receipts with fresh imports
      try {
        const deletedCount = await this.deleteEmailReceipts(user.id);
        console.log(`🗑️  Deleted ${deletedCount} existing email-based receipts for user ${user.id}`);
        } catch (error) {
          const errorMsg = `Failed to delete existing email receipts: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`❌ ${errorMsg}`);
          errors.push(errorMsg);
          criticalErrors.push(errorMsg); // Deletion failure is critical
          // Continue with import even if deletion fails - user should be notified
        }

      // Calculate total amount (from valid food receipts)
      const totalAmount = validReceipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

      // Import receipts to database (only valid receipts with restaurant names)
      let importedCount = 0;
      if (validReceipts.length > 0) {

        // Deduplicate receipts before saving
        // Strategy: Group by externalId (Uber UUID), keep the one with highest total (Tip Update)
        // Calculate Naive Total (Pre-dedupe)
        const naiveTotal = validReceipts.reduce((sum, r) => sum + r.amountSpent, 0);
        console.log(`💰 DEBUG: Naive Total (All Receipts): $${naiveTotal.toFixed(2)}`);

        const uniqueReceipts = new Map<string, Receipt>();
        const validReceiptsList: Receipt[] = [];

        // DEBUG: Analyze how many receipts have externalIds
        const totalWithId = validReceipts.filter(r => r.externalId).length;
        const totalUber = validReceipts.filter(r =>
          r.receiptType === 'uber_eats' ||
          (r.restaurantName && r.restaurantName.toLowerCase().includes('uber'))
        ).length;

        console.log(`🔍 DEBUG: Found ${validReceipts.length} valid receipts.`);
        console.log(`🔍 DEBUG: ${totalUber} look like Uber receipts.`);
        console.log(`🔍 DEBUG: ${totalWithId} have extracted Order UUIDs.`);

        if (totalWithId > 0) {
          console.log(`🔍 DEBUG: Sample UUID: ${validReceipts.find(r => r.externalId)?.externalId}`);
        } else if (totalUber > 0) {
          console.log(`⚠️ DEBUG WARNING: Uber receipts found but 0 UUIDs extracted. Extraction logic failure suspected.`);
        }

        let duplicatesFound = 0;
        let higherAmountReplacements = 0;

        for (const receipt of validReceipts) {
          if (receipt.externalId) {
            const existing = uniqueReceipts.get(receipt.externalId);
            if (!existing) {
              uniqueReceipts.set(receipt.externalId, receipt);
            } else {
              duplicatesFound++;
              // Conflict: Same Order UUID. Keep the one with higher total (Tip Update)
              if (receipt.amountSpent > existing.amountSpent) {
                higherAmountReplacements++;
                uniqueReceipts.set(receipt.externalId, receipt);
                console.log(`♻️  Replacing receipt for order ${receipt.externalId} with higher amount ($${receipt.amountSpent} vs $${existing.amountSpent})`);
              } else {
                console.log(`Start skipping duplicate for order ${receipt.externalId} ($${receipt.amountSpent} vs $${existing.amountSpent})`);
              }
            }
          } else {
            // No UUID? Keep it (legacy behavior)
            validReceiptsList.push(receipt);
          }
        }

        // Merge deduped UUID receipts back into list
        for (const r of uniqueReceipts.values()) {
          validReceiptsList.push(r);
        }

        // Calculate Final Total
        const finalTotal = validReceiptsList.reduce((sum, r) => sum + r.amountSpent, 0);

        console.log(`📊 DEBUG: Analysis Complete`);
        console.log(`   - Original Count: ${validReceipts.length}`);
        console.log(`   - Unique Count:   ${validReceiptsList.length}`);
        console.log(`   - Duplicates:     ${duplicatesFound}`);
        console.log(`   - Replacements:   ${higherAmountReplacements} (Tip Updates)`);
        console.log(`   - Naive Total:    $${naiveTotal.toFixed(2)}`);
        console.log(`   - Final Total:    $${finalTotal.toFixed(2)}`);
        console.log(`   - Difference:     $${(naiveTotal - finalTotal).toFixed(2)}`);

        console.log(`Analyzed ${validReceipts.length} receipts. Found ${validReceiptsList.length} unique orders.`);

        // OPTIMIZATION: Use batch insert for 10-20x faster database writes
        // Receipts are already deduplicated above, so we can insert directly
        try {
          const insertedIds = await this.receiptService.createReceiptsBatch(validReceiptsList);
          importedCount = insertedIds.length;
          
          // Log summary instead of individual receipts for cleaner output
          if (importedCount > 0) {
            const sampleReceipts = validReceiptsList.slice(0, 3);
            console.log(`✅ Sample of imported receipts:`);
            sampleReceipts.forEach((r, i) => {
              console.log(`   ${i + 1}. ${r.restaurantName} - $${r.amountSpent.toFixed(2)} on ${r.orderDate?.toISOString().split('T')[0] || 'unknown date'}`);
            });
            if (validReceiptsList.length > 3) {
              console.log(`   ... and ${validReceiptsList.length - 3} more receipts`);
            }
          }
        } catch (error) {
          const errorMsg = `Batch insert failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          criticalErrors.push(errorMsg); // Database insert failure is critical
          console.error(`❌ ${errorMsg}`);
        }

        // Invalidate cache for this user
        await cacheService.invalidateAllUserCaches(user.id);
        console.log(`✅ Imported ${importedCount} receipts for user ${user.id}`);

        // Return the correct final total
        // Only mark as failed if there are critical errors (not conversion errors for non-receipt emails)
        return {
          success: criticalErrors.length === 0 && importedCount > 0,
          totalEmailsFound: emails.length,
          totalReceiptsProcessed: receipts.length, // Count of emails that were receipts
          totalReceiptsImported: importedCount,
          totalAmount: finalTotal, // Use deduped total
          errors,
          receipts: validReceiptsList // return deduped list
        };
      }

      // Fallback if loop was skipped (should satisfy TS)
      return {
        success: criticalErrors.length === 0,
        totalEmailsFound: emails.length,
        totalReceiptsProcessed: receipts.length, // Count of emails that were receipts
        totalReceiptsImported: importedCount,
        totalAmount: 0,
        errors,
        receipts: []
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Gmail import error:', errorMsg);

      return {
        success: false,
        totalEmailsFound: 0,
        totalReceiptsProcessed: 0,
        totalReceiptsImported: 0,
        totalAmount: 0,
        errors: [errorMsg],
        receipts: []
      };
    }
  }

  /**
   * Delete all email-based receipts for a user
   * @returns Number of receipts deleted
   */
  private async deleteEmailReceipts(userId: string): Promise<number> {
    // This would be better as a method in ReceiptService, but for now we'll use direct query
    const postgres = (this.receiptService as any).postgres as PostgresService;
    const result = await postgres.query(
      "DELETE FROM receipts WHERE user_id = $1 AND data_source = 'email'",
      [userId]
    );
    return result.rowCount || 0;
  }

  /**
   * Get count of email-based receipts for a user
   */
  async getEmailReceiptCount(userId: string): Promise<number> {
    const postgres = (this.receiptService as any).postgres as PostgresService;
    const result = await postgres.query(
      "SELECT COUNT(*) as count FROM receipts WHERE user_id = $1 AND data_source = 'email'",
      [userId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Get total amount from email-based receipts for a user
   */
  async getEmailReceiptTotal(userId: string): Promise<number> {
    const postgres = (this.receiptService as any).postgres as PostgresService;
    const result = await postgres.query(
      "SELECT COALESCE(SUM(amount_spent), 0) as total FROM receipts WHERE user_id = $1 AND data_source = 'email'",
      [userId]
    );
    return parseFloat(result.rows[0].total);
  }

  /**
   * Convert extraction result to Receipt object
   * Maps the extraction data format to the Receipt model
   */
  private convertExtractionToReceipt(userId: string, result: ExtractionResult): Receipt | null {
    const data = result.data;
    if (!data) return null;

    // Skip non-food receipts (Uber rides, etc.)
    if (data.service === ServiceType.UBER_RIDE || data.service === ServiceType.UBER_OTHER) {
      return null;
    }

    // Determine receipt type from service
    let receiptType: ReceiptType;
    switch (data.service) {
      case ServiceType.UBER_EATS:
        receiptType = ReceiptType.UBER_EATS;
        break;
      case ServiceType.DOORDASH:
        receiptType = ReceiptType.DOORDASH;
        break;
      case ServiceType.GRUBHUB:
        receiptType = ReceiptType.GRUBHUB;
        break;
      case ServiceType.SKIP_THE_DISHES:
        // Map to UNKNOWN since ReceiptType doesn't have SKIP_THE_DISHES
        // TODO: Add SKIP_THE_DISHES to ReceiptType enum if needed
        receiptType = ReceiptType.UNKNOWN;
        break;
      default:
        // Mark as UNKNOWN for non-food receipts to filter out later
        receiptType = ReceiptType.UNKNOWN;
    }

    // Skip if no total amount
    if (data.total === null || data.total === undefined) {
      return null;
    }

    // Create receipt with extracted data
    const receipt = new Receipt(
      userId,
      [], // Items not extracted from email HTML currently
      data.total,
      receiptType,
      data.merchant || 'Unknown Restaurant',
      data.parsedDate || undefined,
      DataSource.EMAIL,
      undefined, // deliveryTime not extracted
      data.orderId || undefined // externalId for deduplication
    );

    return receipt;
  }
}

