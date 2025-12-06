import { User } from '../../models/User';
import { Receipt, ReceiptType } from '../../models/Receipt';
import { GmailClient } from '../email/GmailClient';
import { EmailFilterService } from '../email/EmailFilterService';
import { ReceiptParserService } from '../receipt/ReceiptParserService';
import { ReceiptService } from '../receipt/ReceiptService';
import { PostgresService } from '../data/PostgresService';
import { cacheService } from '../core/CacheService';
import * as fs from 'fs';
import * as path from 'path';

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
 */
export class GmailImportService {
  private gmailClient: GmailClient;
  private filterService: EmailFilterService;
  private parserService: ReceiptParserService;
  private receiptService: ReceiptService;

  constructor(postgres: PostgresService) {
    this.gmailClient = new GmailClient();
    this.filterService = new EmailFilterService();
    this.parserService = new ReceiptParserService();
    this.receiptService = new ReceiptService(postgres);
  }

  /**
   * Import Uber Eats receipts from Gmail for a user
   * @param user User object with Gmail OAuth tokens
   * @param replaceExisting If true, delete existing email-based receipts before import
   */
  async importFromGmail(user: User, replaceExisting: boolean = false): Promise<GmailImportResult> {
    const errors: string[] = [];

    try {
      // Validate user has Gmail connected
      if (!user.gmailRefreshToken) {
        throw new Error('User does not have Gmail connected');
      }

      // Fetch emails from Gmail
      console.log(`📧 Fetching emails from Gmail for user: ${user.email}`);
      const emails = await this.gmailClient.getEmails(user);
      console.log(`📧 Found ${emails.length} emails from Gmail`);

      // Filter emails to only receipts
      const receiptEmails = emails.filter(email => {
        const classification = this.filterService.classifyEmail(email);
        if (classification.isReceipt) {
          console.log(`✅ Email classified as receipt: ${classification.reason}`);
          return true;
        } else {
          console.log(`❌ Email not a receipt: ${classification.reason}`);
          return false;
        }
      });

      console.log(`📧 Filtered to ${receiptEmails.length} receipt emails`);

      // Parse emails to receipts
      const receipts: Receipt[] = [];
      const emailReceiptPairs: Array<{ email: typeof receiptEmails[0], receipt: Receipt | null }> = [];

      for (const email of receiptEmails) {
        try {
          const receipt = this.parserService.parseEmailToReceipt(email);
          emailReceiptPairs.push({ email, receipt });

          if (receipt) {
            receipts.push(receipt);
            console.log(`✅ Parsed receipt: $${receipt.amountSpent} from ${receipt.restaurantName || 'Unknown'}`);
          } else {
            errors.push(`Failed to parse email from ${email.from}`);
            console.log(`❌ Failed to parse email from ${email.from}`);
          }
        } catch (error) {
          emailReceiptPairs.push({ email, receipt: null });
          const errorMsg = `Error parsing email: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      console.log(`📧 Parsed ${receipts.length} receipts from emails`);

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

      // Calculate total amount (from valid food receipts)
      const totalAmount = validReceipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

      // Import receipts to database (only valid receipts with restaurant names)
      let importedCount = 0;
      if (validReceipts.length > 0) {
        if (replaceExisting) {
          // Delete existing email-based receipts for this user
          await this.deleteEmailReceipts(user.id);
          console.log(`🗑️  Deleted existing email-based receipts for user ${user.id}`);
        }

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

        // Import new receipts
        for (const receipt of validReceiptsList) {
          try {
            const receiptId = await this.receiptService.createReceipt(receipt);
            importedCount++;
            console.log(`✅ Saved receipt #${importedCount}: ${receipt.restaurantName} - $${receipt.amountSpent.toFixed(2)} on ${receipt.orderDate?.toISOString().split('T')[0] || 'unknown date'} (ID: ${receiptId}, OrderUUID: ${receipt.externalId || 'none'})`);
          } catch (error) {
            const errorMsg = `Error importing receipt from ${receipt.restaurantName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(`❌ ${errorMsg}`);
          }
        }

        // Invalidate cache for this user
        await cacheService.invalidateAllUserCaches(user.id);
        console.log(`✅ Imported ${importedCount} receipts for user ${user.id}`);

        // Return the correct final total
        return {
          success: errors.length === 0,
          totalEmailsFound: emails.length,
          totalReceiptsProcessed: receiptEmails.length,
          totalReceiptsImported: importedCount,
          totalAmount: finalTotal, // Use deduped total
          errors,
          receipts: validReceiptsList // return deduped list
        };
      }

      // Fallback if loop was skipped (should satisfy TS)
      return {
        success: errors.length === 0,
        totalEmailsFound: emails.length,
        totalReceiptsProcessed: receiptEmails.length,
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
   */
  private async deleteEmailReceipts(userId: string): Promise<void> {
    // This would be better as a method in ReceiptService, but for now we'll use direct query
    const postgres = (this.receiptService as any).postgres as PostgresService;
    await postgres.query(
      "DELETE FROM receipts WHERE user_id = $1 AND data_source = 'email'",
      [userId]
    );
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
}

