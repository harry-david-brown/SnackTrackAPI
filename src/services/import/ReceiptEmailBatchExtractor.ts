import pLimit from 'p-limit';
import { DataSource, Receipt, ReceiptType } from '../../models/Receipt';
import { getDefaultTimezone, parseReceiptLocalDateTime } from '../../utils/timezone';
import type { EmailDebugCapturePort, MailboxMessage } from '../ports/MailboxPorts';
import type { ExtractionResult, RawEmail } from '../extraction';
import { ServiceType } from '../extraction';
import { decodeExtractionResult } from '../extraction/ExtractionResultDecoder';

export interface ReceiptEmailExtractor {
  extract(email: RawEmail): unknown;
}

export interface ReceiptEmailExtractionBatch {
  readonly extractedReceipts: Receipt[];
  readonly supportedReceipts: Receipt[];
  readonly errors: string[];
  readonly nonReceiptCount: number;
  readonly nonFoodCount: number;
  readonly durationMs: number;
}

/** Maps provider-neutral messages through receipt extraction into domain receipts. */
export class ReceiptEmailBatchExtractor {
  constructor(
    private readonly extractor: ReceiptEmailExtractor,
    private readonly debugCapture: EmailDebugCapturePort,
    private readonly concurrency = 10,
    private readonly clock: () => number = Date.now,
  ) {}

  async extract(
    emails: readonly MailboxMessage[],
    userTimezone: string | undefined,
    diagnostics: { userId: string; trigger: 'manual' | 'background' },
  ): Promise<ReceiptEmailExtractionBatch> {
    const startedAt = this.clock();
    const limit = pLimit(this.concurrency);
    const results = await Promise.all(
      emails.map((email) =>
        limit(async () => ({
          email,
          result: decodeExtractionResult(this.extractor.extract(this.toRawEmail(email))),
        })),
      ),
    );
    const extractedReceipts: Receipt[] = [];
    const errors: string[] = [];
    let nonReceiptCount = 0;

    for (const { email, result } of results) {
      if (!result.classification.isReceipt || !result.data) {
        nonReceiptCount += 1;
        continue;
      }
      const receipt = this.toReceipt(email.userId, result, userTimezone || getDefaultTimezone());
      if (receipt) extractedReceipts.push(receipt);
      else errors.push('Failed to convert a supported receipt email');
    }

    const supportedReceipts = extractedReceipts.filter(
      (receipt) => receipt.receiptType !== ReceiptType.UNKNOWN,
    );
    const nonFoodCount = extractedReceipts.length - supportedReceipts.length;
    if (nonFoodCount) {
      await this.debugCapture.capture('gmail-non-food-receipts', {
        userId: diagnostics.userId,
        count: nonFoodCount,
        triggerType: diagnostics.trigger,
      });
    }
    for (const receipt of supportedReceipts) {
      if (!receipt.restaurantName || receipt.restaurantName === 'Unknown Restaurant') {
        receipt.restaurantName = 'Unknown Restaurant';
      }
    }
    return {
      extractedReceipts,
      supportedReceipts,
      errors,
      nonReceiptCount,
      nonFoodCount,
      durationMs: this.clock() - startedAt,
    };
  }

  private toRawEmail(email: MailboxMessage): RawEmail {
    return {
      userId: email.userId,
      from: email.from,
      to: email.to,
      body: email.body,
      subject: email.subject,
      providerMessageId: email.providerMessageId,
      receivedAt: email.receivedAt,
    };
  }

  private toReceipt(userId: string, result: ExtractionResult, timezone: string): Receipt | null {
    const data = result.data;
    if (
      !data ||
      data.service === ServiceType.UBER_RIDE ||
      data.service === ServiceType.UBER_OTHER
    ) {
      return null;
    }
    const receiptType = this.receiptType(data.service);
    if (data.total === null || data.total === undefined) return null;
    const localOrderDate = parseReceiptLocalDateTime(data.orderDate, data.orderTime, timezone);
    return new Receipt(
      userId,
      [],
      data.total,
      receiptType,
      data.merchant || 'Unknown Restaurant',
      localOrderDate || data.parsedDate || undefined,
      DataSource.EMAIL,
      undefined,
      data.orderId || undefined,
    );
  }

  private receiptType(service: ServiceType): ReceiptType {
    switch (service) {
      case ServiceType.UBER_EATS:
        return ReceiptType.UBER_EATS;
      case ServiceType.DOORDASH:
        return ReceiptType.DOORDASH;
      case ServiceType.GRUBHUB:
        return ReceiptType.GRUBHUB;
      default:
        return ReceiptType.UNKNOWN;
    }
  }
}
