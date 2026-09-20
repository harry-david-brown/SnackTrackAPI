import type { ReceiptType, ReceiptWriteCommand } from '../../models/Receipt';
import type { MailboxProvider } from '../mailbox/MailboxConnection';

export const retainedEmailRejectionReasons = ['message_too_large', 'body_too_large', 'sender_not_allowed',
  'dmarc_failed', 'provider_payload_invalid', 'unsupported_receipt', 'different_delivery_provider', 'extraction_failed'] as const;
export type RetainedEmailRejectionReason = (typeof retainedEmailRejectionReasons)[number];
export interface RetainedEmailDiagnostics {
  version: 1;
  mailboxProvider: MailboxProvider;
  sourceMessages: number;
  duplicateMessages: number;
  acceptedMessages: number;
  rejected: Record<RetainedEmailRejectionReason, number>;
}

export function decodeRetainedEmailDiagnostics(value: unknown): RetainedEmailDiagnostics {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const invalid = (): never => { throw new Error('Invalid retained email diagnostics'); };
  if (!object(value) || value.version !== 1 || (value.mailboxProvider !== 'gmail' && value.mailboxProvider !== 'microsoft') ||
    !count(value.sourceMessages) || !count(value.duplicateMessages) || !count(value.acceptedMessages) || !object(value.rejected)) return invalid();
  const rejected: RetainedEmailDiagnostics['rejected'] = {message_too_large:0, body_too_large:0, sender_not_allowed:0,
    dmarc_failed:0, provider_payload_invalid:0, unsupported_receipt:0, different_delivery_provider:0, extraction_failed:0};
  for (const key of retainedEmailRejectionReasons) {
    const n = value.rejected[key]; if (!count(n)) return invalid(); rejected[key] = n;
  }
  if (Object.keys(value.rejected).some(key => !retainedEmailRejectionReasons.some(reason => reason === key)) ||
    value.sourceMessages !== value.duplicateMessages + value.acceptedMessages + Object.values(rejected).reduce((a,b)=>a+b,0)) return invalid();
  return {version:1, mailboxProvider:value.mailboxProvider, sourceMessages:value.sourceMessages,
    duplicateMessages:value.duplicateMessages, acceptedMessages:value.acceptedMessages, rejected};
}

export interface RepairSourceProvenance {
  sourceKind: 'provider_export' | 'retained_email';
  provider: ReceiptType;
  /** A display label, never a signed URL, authorization token or raw archive. */
  sourceLabel: string;
  acquiredAt: string;
  successfulCompletion: boolean;
  rejectedRecords: number;
  /** Content identity of a retained file, not its private path or a download URL. */
  artifact?: { sha256: string; sizeBytes: number };
  /** Account timezone used as the parser fallback at acquisition. */
  parsingTimezone?: string;
  /** Bounded acquisition counts, never message bodies, sender addresses or provider credentials. */
  emailDiagnostics?: RetainedEmailDiagnostics;
  declaredCoverage?: readonly { start: string; end: string }[];
}

export interface ReceiptRepairSourcePort {
  stageRepairSources(
    userId: string,
    generation: number,
    receipts: readonly ReceiptWriteCommand[],
    provenance: RepairSourceProvenance,
    assertWriteAllowed: () => Promise<void>,
  ): Promise<{ batchId: string; observations: number; fingerprint: string }>;
}
