import { User } from '../../models/User';
import { Receipt } from '../../models/Receipt';
import { GmailClient } from '../email/GmailClient';
import { EmailFilterService } from '../email/EmailFilterService';
import { ReceiptParserService } from '../receipt/ReceiptParserService';
import { ReceiptService } from '../receipt/ReceiptService';
import { PostgresService } from '../data/PostgresService';
import { cacheService } from '../core/CacheService';

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
      for (const email of receiptEmails) {
        try {
          const receipt = this.parserService.parseEmailToReceipt(email);
          if (receipt) {
            receipts.push(receipt);
            console.log(`✅ Parsed receipt: $${receipt.amountSpent} from ${receipt.restaurantName || 'Unknown'}`);
          } else {
            errors.push(`Failed to parse email from ${email.from}`);
            console.log(`❌ Failed to parse email from ${email.from}`);
          }
        } catch (error) {
          const errorMsg = `Error parsing email: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      console.log(`📧 Parsed ${receipts.length} receipts from emails`);

      // Calculate total amount
      const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);

      // Import receipts to database
      let importedCount = 0;
      if (receipts.length > 0) {
        if (replaceExisting) {
          // Delete existing email-based receipts for this user
          await this.deleteEmailReceipts(user.id);
          console.log(`🗑️  Deleted existing email-based receipts for user ${user.id}`);
        }

        // Import new receipts
        for (const receipt of receipts) {
          try {
            await this.receiptService.createReceipt(receipt);
            importedCount++;
          } catch (error) {
            const errorMsg = `Error importing receipt: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(errorMsg);
          }
        }

        // Invalidate cache for this user
        await cacheService.invalidateAllUserCaches(user.id);
        console.log(`✅ Imported ${importedCount} receipts for user ${user.id}`);
      }

      return {
        success: errors.length === 0,
        totalEmailsFound: emails.length,
        totalReceiptsProcessed: receiptEmails.length,
        totalReceiptsImported: importedCount,
        totalAmount,
        errors,
        receipts
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

