import { User } from '../../models/User';
import { Receipt, ReceiptType, DataSource } from '../../models/Receipt';
import { GmailClient } from '../email/GmailClient';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { CacheService } from '../core/CacheService';
import { ReceiptExtractor, RawEmail, ExtractionResult, ServiceType } from '../extraction';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';
import { getDefaultTimezone, parseReceiptLocalDateTime } from '../../utils/timezone';
import { ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { UserRepository } from '../data/UserRepository';
import { ImportLockHandle, ImportLockService } from './ImportLockService';

export const isGmailReconnectError = (error: unknown): boolean => {
  const candidate = error as any;
  const values = [
    candidate?.message,
    candidate?.code,
    candidate?.response?.data?.error,
    candidate?.response?.data?.error_description,
  ];
  return values.some(value => String(value || '').toLowerCase().includes('invalid_grant'));
};

export interface GmailImportResult {
  success: boolean;
  totalEmailsFound: number;
  totalReceiptsProcessed: number;
  emailsExamined: number;
  supportedReceiptsFound: number;
  exportCoveredReceipts: number;
  eligibleReceipts: number;
  deduplicatedReceipts: number;
  totalReceiptsImported: number;
  totalAmount: number;
  errors: string[];
  receipts: Receipt[];
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
  errorCode: string | null;
}

export type ExportCutoffsByReceiptType = Partial<Record<ReceiptType, Date>>;

export const resolveIncrementalGmailSearchAfter = ({
  lastSuccessfulCheckAt,
  gmailBaselineCompletedAt,
  csvCutoffs,
}: {
  lastSuccessfulCheckAt: string | null;
  gmailBaselineCompletedAt: string | null;
  csvCutoffs: ExportCutoffsByReceiptType;
}): Date | undefined => {
  const lastSuccessfulCheck = lastSuccessfulCheckAt
    ? new Date(lastSuccessfulCheckAt)
    : null;
  const exportDates = Object.values(csvCutoffs)
    .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
  const firstExportCutoff = exportDates.length > 0
    ? new Date(Math.min(...exportDates.map(value => value.getTime())))
    : null;
  const gmailBaseline = gmailBaselineCompletedAt
    ? new Date(gmailBaselineCompletedAt)
    : null;
  const anchor = lastSuccessfulCheck && !Number.isNaN(lastSuccessfulCheck.getTime())
    ? lastSuccessfulCheck
    : firstExportCutoff
      ?? (gmailBaseline && !Number.isNaN(gmailBaseline.getTime()) ? gmailBaseline : null);
  if (!anchor) return undefined;
  return new Date(anchor.getTime() - 48 * 60 * 60 * 1000);
};

export const filterReceiptsAfterExportCutoffs = (
  receipts: Receipt[],
  cutoffs: ExportCutoffsByReceiptType
): Receipt[] => receipts.filter(receipt => {
  const cutoff = cutoffs[receipt.receiptType];
  return !cutoff || Boolean(receipt.orderDate && receipt.orderDate > cutoff);
});

/**
 * Service to orchestrate incremental Uber Eats receipt synchronization from Gmail
 * Uses existing email infrastructure to fetch, filter, and parse emails
 * 
 * Performance optimizations:
 * - Parallel email fetching from Gmail API
 * - Combined classification + extraction (no redundant classification)
 * - Parallel receipt parsing with concurrency limiting
 */
export class GmailImportService {
  constructor(
    private readonly gmailClient: GmailClient,
    private readonly extractor: ReceiptExtractor,
    private readonly receipts: ReceiptRepository,
    private readonly importPreferences: ImportPreferencesRepository,
    private readonly users: UserRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * Import Uber Eats receipts from Gmail for a user
   * Upserts existing email receipts and preserves their original discovery time.
   * @param user User object with Gmail OAuth tokens
   * 
   * Performance optimizations:
   * - Parallel extraction with concurrency limiting (10 concurrent)
   * - Combined classification + extraction (single pass, no redundant work)
   */
  async importFromGmail(
    user: User,
    lockHandle: ImportLockHandle,
    triggerType: 'manual' | 'background' = 'manual'
  ): Promise<GmailImportResult> {
    const errors: string[] = [];
    const criticalErrors: string[] = []; // Errors that should mark import as failed
    const syncRunId = await this.importPreferences.startSyncRun(user.id, triggerType);

    try {
      const hasRefreshToken = !!user.gmailRefreshToken;
      const hasAccessToken = !!user.gmailAccessToken;
      const tokenExpiry = user.gmailTokenExpiry ? new Date(user.gmailTokenExpiry).getTime() : null;
      const accessTokenUsable = hasAccessToken && (!tokenExpiry || (!Number.isNaN(tokenExpiry) && tokenExpiry > Date.now()));

      if (!hasRefreshToken && !accessTokenUsable) {
        throw new Error('User does not have a usable Gmail connection');
      }

      // Export coverage is provider-specific. It both prevents historical
      // duplicates and gives the first consented tracking check its starting
      // point without pretending the explicit Gmail baseline ran.
      const csvCutoffs = await this.getLatestCsvReceiptDates(user.id);
      const searchAfter = triggerType === 'background'
        ? await this.getIncrementalSearchAfter(user.id, csvCutoffs)
        : undefined;

      // Fetch emails from Gmail (already parallelized in GmailClient)
      console.log(`📧 Fetching emails from Gmail for user: ${user.email}`);
      const emails = await this.gmailClient.getEmails(user, { after: searchAfter });
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
          const receipt = this.convertExtractionToReceipt(
            email.userId,
            result,
            user.timezone || getDefaultTimezone()
          );
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

      // Each provider's export is authoritative only for that provider through
      // its latest order. Do not let a DoorDash cutoff suppress Uber receipts,
      // or vice versa.
      const validReceipts = filterReceiptsAfterExportCutoffs(foodReceipts, csvCutoffs);
      const exportCoveredReceipts = foodReceipts.length - validReceipts.length;
      if (Object.keys(csvCutoffs).length > 0) {
        console.log(`📧 Skipped ${foodReceipts.length - validReceipts.length} Gmail receipts already covered by the uploaded export`);
      }
      console.log(`📧 ${validReceipts.length} delivery receipts ready for import`);

      // Import receipts to database (only valid receipts with restaurant names)
      let importedCount = 0;
      let newOrders = 0;
      let updatedOrders = 0;
      let unchangedOrders = 0;
      if (validReceipts.length > 0) {

        // Deduplicate receipts before saving
        // Strategy: Group by externalId when available, otherwise by normalized
        // merchant + order minute. Keep the highest total (tip-update receipt).
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
          const fallbackKey = receipt.orderDate
            ? `${receipt.restaurantName?.trim().toLowerCase() || 'unknown'}|${receipt.orderDate.toISOString().slice(0, 16)}`
            : null;
          const dedupeKey = receipt.externalId
            ? `external:${receipt.externalId}`
            : fallbackKey ? `fallback:${fallbackKey}` : null;

          if (dedupeKey) {
            const existing = uniqueReceipts.get(dedupeKey);
            if (!existing) {
              uniqueReceipts.set(dedupeKey, receipt);
            } else {
              duplicatesFound++;
              // Conflict: Same Order UUID. Keep the one with higher total (Tip Update)
              if (receipt.amountSpent > existing.amountSpent) {
                higherAmountReplacements++;
                uniqueReceipts.set(dedupeKey, receipt);
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

        // Incrementally merge receipts. Existing rows keep first_seen_at, while
        // tip adjustments update the order without pretending it is new.
        try {
          const upsertResult = await this.receipts.upsertEmailReceipts(
            validReceiptsList,
            () => ImportLockService.assertLockOwned(lockHandle)
          );
          newOrders = upsertResult.newOrders;
          updatedOrders = upsertResult.updatedOrders;
          unchangedOrders = upsertResult.unchangedOrders;
          importedCount = newOrders + updatedOrders + unchangedOrders;
          
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
        await this.cache.invalidateAllUserCaches(user.id);
        console.log(`✅ Imported ${importedCount} receipts for user ${user.id}`);

        if (criticalErrors.length > 0) {
          await this.importPreferences.failSyncRun(syncRunId, user.id, 'GMAIL_IMPORT_WRITE_FAILED', triggerType);
        } else {
          await this.importPreferences.completeSyncRun(
            syncRunId,
            user.id,
            errors.length > 0 ? 'partial' : 'success',
            {
              emailsScanned: emails.length,
              receiptsProcessed: receipts.length,
              supportedReceiptsFound: foodReceipts.length,
              exportCoveredReceipts,
              eligibleReceipts: validReceipts.length,
              deduplicatedReceipts: validReceiptsList.length,
              newOrders,
              updatedOrders,
              unchangedOrders,
            },
            triggerType
          );
        }

        // Return the correct final total
        // Only mark as failed if there are critical errors (not conversion errors for non-receipt emails)
        return {
          // A completed scan is successful even when the uploaded export
          // already covers every matching Gmail receipt.
          success: criticalErrors.length === 0,
          totalEmailsFound: emails.length,
          totalReceiptsProcessed: receipts.length, // Count of emails that were receipts
          emailsExamined: emails.length,
          supportedReceiptsFound: foodReceipts.length,
          exportCoveredReceipts,
          eligibleReceipts: validReceipts.length,
          deduplicatedReceipts: validReceiptsList.length,
          totalReceiptsImported: importedCount,
          totalAmount: finalTotal, // Use deduped total
          errors,
          receipts: validReceiptsList, // return deduped list
          newOrders,
          updatedOrders,
          unchangedOrders,
          errorCode: null,
        };
      }

      await this.importPreferences.completeSyncRun(syncRunId, user.id, 'success', {
        emailsScanned: emails.length,
        receiptsProcessed: receipts.length,
        supportedReceiptsFound: foodReceipts.length,
        exportCoveredReceipts,
        eligibleReceipts: validReceipts.length,
        deduplicatedReceipts: 0,
        newOrders: 0,
        updatedOrders: 0,
        unchangedOrders: 0,
      }, triggerType);

      // A successful scan can legitimately find no matching receipts.
      return {
        success: criticalErrors.length === 0,
        totalEmailsFound: emails.length,
        totalReceiptsProcessed: receipts.length, // Count of emails that were receipts
        emailsExamined: emails.length,
        supportedReceiptsFound: foodReceipts.length,
        exportCoveredReceipts,
        eligibleReceipts: validReceipts.length,
        deduplicatedReceipts: 0,
        totalReceiptsImported: importedCount,
        totalAmount: 0,
        errors,
        receipts: [],
        newOrders: 0,
        updatedOrders: 0,
        unchangedOrders: 0,
        errorCode: null,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = this.getErrorCode(error);
      console.error('Gmail import error:', errorMsg);
      await this.importPreferences.failSyncRun(syncRunId, user.id, errorCode, triggerType);
      if (errorCode === 'GMAIL_RECONNECT_REQUIRED') {
        await this.users.markGmailReconnectRequired(user.id);
        await this.importPreferences.markTrackingReconnectRequired(user.id);
      }

      return {
        success: false,
        totalEmailsFound: 0,
        totalReceiptsProcessed: 0,
        emailsExamined: 0,
        supportedReceiptsFound: 0,
        exportCoveredReceipts: 0,
        eligibleReceipts: 0,
        deduplicatedReceipts: 0,
        totalReceiptsImported: 0,
        totalAmount: 0,
        errors: [errorMsg],
        receipts: [],
        newOrders: 0,
        updatedOrders: 0,
        unchangedOrders: 0,
        errorCode,
      };
    }
  }

  private getErrorCode(error: unknown): string {
    if (isGmailReconnectError(error)) return 'GMAIL_RECONNECT_REQUIRED';
    const status = (error as any)?.response?.status;
    const code = (error as any)?.code;
    if (code) return String(code).substring(0, 80);
    if (status) return `HTTP_${status}`;
    return 'GMAIL_SYNC_FAILED';
  }

  private async getLatestCsvReceiptDates(userId: string): Promise<ExportCutoffsByReceiptType> {
    return this.receipts.getLatestCsvReceiptDates(userId);
  }

  private async getIncrementalSearchAfter(
    userId: string,
    csvCutoffs: ExportCutoffsByReceiptType
  ): Promise<Date | undefined> {
    const preferences = await this.importPreferences.get(userId);
    // Gmail's `after` filter uses message time, while export cutoffs use order
    // time. Re-read a small window so delayed or updated receipts are not lost;
    // stable source identities make this idempotent.
    return resolveIncrementalGmailSearchAfter({
      lastSuccessfulCheckAt: preferences.lastSuccessfulCheckAt,
      gmailBaselineCompletedAt: preferences.gmailBaselineCompletedAt,
      csvCutoffs,
    });
  }

  /**
   * Get count of email-based receipts for a user
   */
  async getEmailReceiptCount(userId: string): Promise<number> {
    return (await this.receipts.getEmailReceiptStats(userId)).count;
  }

  /**
   * Get total amount from email-based receipts for a user
   */
  async getEmailReceiptTotal(userId: string): Promise<number> {
    return (await this.receipts.getEmailReceiptStats(userId)).total;
  }

  /**
   * Convert extraction result to Receipt object
   * Maps the extraction data format to the Receipt model
   */
  private convertExtractionToReceipt(
    userId: string,
    result: ExtractionResult,
    timezone: string
  ): Receipt | null {
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
    const localOrderDate = parseReceiptLocalDateTime(data.orderDate, data.orderTime, timezone);
    const receipt = new Receipt(
      userId,
      [], // Items not extracted from email HTML currently
      data.total,
      receiptType,
      data.merchant || 'Unknown Restaurant',
      localOrderDate || data.parsedDate || undefined,
      DataSource.EMAIL,
      undefined, // deliveryTime not extracted
      data.orderId || undefined // externalId for deduplication
    );

    return receipt;
  }
}
