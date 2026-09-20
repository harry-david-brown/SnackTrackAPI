import pLimit from 'p-limit';
import { DataSource, Receipt, ReceiptType } from '../../models/Receipt';
import { getDefaultTimezone, getLocalDateKey, parseReceiptLocalDateTime } from '../../utils/timezone';
import type { EmailDebugCapturePort, MailboxMessage } from '../ports/MailboxPorts';
import type { ExtractionResult, RawEmail } from '../extraction';
import { ServiceType } from '../extraction';
import { decodeExtractionResult } from '../extraction/ExtractionResultDecoder';
import { extractEmailOrderEvidence } from '../extraction/ReceiptOrderEvidenceExtractor';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import { zonedDateTimeToUtc } from '../../utils/timezone';

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
    private readonly policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
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
      if (receipt) {
        const orderEvidence = this.policyVersion === 3 ? extractEmailOrderEvidence({ text: result.rawText, total: result.data.total, receivedAt: email.receivedAt, timezone: userTimezone || getDefaultTimezone() }) : undefined;
        if (orderEvidence) {
          receipt.amountSpent = orderEvidence.recordedTotal ?? 0;
          const placed = orderEvidence.timestamps.find(t => t.role === 'placed' && t.instant);
          const day = orderEvidence.orderHeaderDay?.split('-').map(Number);
          receipt.orderDate = placed?.instant ? new Date(placed.instant) : day ? zonedDateTimeToUtc({ year:day[0],month:day[1],day:day[2],hour:12,minute:0,second:0 }, userTimezone || getDefaultTimezone()) ?? undefined : undefined;
          const delivered = orderEvidence.timestamps.find(t => t.role === 'delivered' && t.instant);
          receipt.deliveryTime = delivered?.instant ? new Date(delivered.instant) : undefined;
        }
        const receivedTimeFallback = !receipt.orderDate && email.receivedAt;
        if (receivedTimeFallback) receipt.orderDate = receivedTimeFallback;
        receipt.resolution = { version: 1, amountBasis: 'receipt_total',
          ...(orderEvidence?.recordedTotal === null ? {} : { receiptTotal: receipt.amountSpent }),
          ...(orderEvidence ? { orderEvidence } : {}),
          adjustments: result.data?.adjustments ?? [], issues: [], sourceMessageId: `${email.provider}:${email.providerMessageId}`,
          sourceRevisionAt: email.receivedAt?.toISOString(), sources: ['email'],
          timestamp: { raw: receivedTimeFallback ? receivedTimeFallback.toISOString() : receipt.orderDate ? getLocalDateKey(receipt.orderDate,userTimezone || getDefaultTimezone()) || '' : '',
            role: receivedTimeFallback || (orderEvidence && !orderEvidence.timestamps.some(t => t.role === 'placed')) ? 'receipt' : 'placed', timezone:userTimezone || getDefaultTimezone(),
            precision: receivedTimeFallback ? 'received' : (orderEvidence ? orderEvidence.timestamps.some(t => t.role === 'placed') : result.data.orderTime) ? 'minute' : 'day',
            convention: receivedTimeFallback ? 'Email received time; order placement time unavailable' : 'Extracted receipt date and optional time' },
          headlineSavings: result.data?.headlineSavings };
        extractedReceipts.push(receipt);
      }
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
      mailboxProvider: email.provider,
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
    if ((data.total === null || data.total === undefined) && !(this.policyVersion === 3 && data.orderEvidence && ['refund','updated','cancellation'].includes(data.orderEvidence.documentKind))) return null;
    const localOrderDate = parseReceiptLocalDateTime(data.orderDate, data.orderTime, timezone);
    return new Receipt(
      userId,
      data.items ?? [],
      data.total ?? 0,
      receiptType,
      data.merchant || 'Unknown Restaurant',
      localOrderDate || data.parsedDate || undefined,
      DataSource.EMAIL,
      undefined,
      data.orderId || undefined,
      undefined,
      {
        currencyCode: data.currency,
        ...(data.subtotal === null ? {} : { subtotal: data.subtotal }),
        ...(data.tax === null ? {} : { tax: data.tax }),
        ...(data.tip === null ? {} : { tip: data.tip }),
        ...(data.deliveryFee === null ? {} : { deliveryFee: data.deliveryFee }),
        ...(data.serviceFee === null ? {} : { serviceFee: data.serviceFee }),
        ...(data.savings === null ? {} : { savings: data.savings }),
      },
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
