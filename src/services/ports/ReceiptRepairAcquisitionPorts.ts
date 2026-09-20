import type { ReceiptWriteCommand } from '../../models/Receipt';
import type { ExportProvider } from '../import/ImportLifecycleTypes';
import type { MailboxProvider } from '../mailbox/MailboxConnection';
import type { RetainedEmailDiagnostics } from '../receipt/ReceiptRepairSources';

export interface ReceiptRepairAccountPort {
  getContext(userId: string): Promise<{ generation: number; timezone: string } | null>;
}

export interface RetainedReceiptSourceReadPort {
  read(input: {
    sourceKind: 'provider_export' | 'retained_email';
    mailboxProvider?: MailboxProvider;
    path: string;
    userId: string;
    provider: ExportProvider;
    timezone: string;
  }): Promise<{
    artifact: { sha256: string; sizeBytes: number };
    receipts: readonly ReceiptWriteCommand[];
    rejectedRecords: number;
    successfulCompletion: boolean;
    emailDiagnostics?: RetainedEmailDiagnostics;
  }>;
}
