import type { User } from '../../models/User';
import type { ReceiptType } from '../../models/Receipt';
import type { MailboxClient, MailboxMessage } from '../ports/MailboxPorts';
import type { ImportPreferences } from './ImportLifecycleTypes';

export type ExportCutoffsByReceiptType = Partial<Record<ReceiptType, Date>>;

interface ReceiptCutoffPort {
  getLatestCsvReceiptDates(userId: string): Promise<ExportCutoffsByReceiptType>;
}

interface ImportPreferencesPort {
  get(userId: string): Promise<ImportPreferences>;
}

export interface GmailAcquisitionResult {
  readonly emails: MailboxMessage[];
  readonly exportCutoffs: ExportCutoffsByReceiptType;
  readonly searchAfter: Date | undefined;
}

export const resolveIncrementalGmailSearchAfter = ({
  lastSuccessfulCheckAt,
  gmailBaselineCompletedAt,
  csvCutoffs,
}: {
  lastSuccessfulCheckAt: string | null;
  gmailBaselineCompletedAt: string | null;
  csvCutoffs: ExportCutoffsByReceiptType;
}): Date | undefined => {
  const lastSuccessfulCheck = lastSuccessfulCheckAt ? new Date(lastSuccessfulCheckAt) : null;
  const exportDates = Object.values(csvCutoffs).filter(
    (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()),
  );
  const firstExportCutoff = exportDates.length
    ? new Date(Math.min(...exportDates.map((value) => value.getTime())))
    : null;
  const gmailBaseline = gmailBaselineCompletedAt ? new Date(gmailBaselineCompletedAt) : null;
  const anchor =
    lastSuccessfulCheck && !Number.isNaN(lastSuccessfulCheck.getTime())
      ? lastSuccessfulCheck
      : (firstExportCutoff ??
        (gmailBaseline && !Number.isNaN(gmailBaseline.getTime()) ? gmailBaseline : null));
  return anchor ? new Date(anchor.getTime() - 48 * 60 * 60 * 1000) : undefined;
};

/** Owns Gmail credential preflight, incremental cursor selection, and message retrieval. */
export class GmailImportAcquisitionService {
  constructor(
    private readonly mailbox: MailboxClient,
    private readonly receipts: ReceiptCutoffPort,
    private readonly preferences: ImportPreferencesPort,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(user: User, trigger: 'manual' | 'background'): Promise<GmailAcquisitionResult> {
    this.requireUsableConnection(user);
    const exportCutoffs = await this.receipts.getLatestCsvReceiptDates(user.id);
    const searchAfter =
      trigger === 'background'
        ? await this.incrementalSearchAfter(user.id, exportCutoffs)
        : undefined;
    const emails = await this.mailbox.getEmails(user, { after: searchAfter });
    return { emails, exportCutoffs, searchAfter };
  }

  private requireUsableConnection(user: User): void {
    const tokenExpiry = user.gmailTokenExpiry ? new Date(user.gmailTokenExpiry).getTime() : null;
    const accessTokenUsable = Boolean(
      user.gmailAccessToken &&
      (!tokenExpiry || (!Number.isNaN(tokenExpiry) && tokenExpiry > this.now())),
    );
    if (!user.gmailRefreshToken && !accessTokenUsable) {
      throw new Error('User does not have a usable Gmail connection');
    }
  }

  private async incrementalSearchAfter(
    userId: string,
    exportCutoffs: ExportCutoffsByReceiptType,
  ): Promise<Date | undefined> {
    const preferences = await this.preferences.get(userId);
    return resolveIncrementalGmailSearchAfter({
      lastSuccessfulCheckAt: preferences.lastSuccessfulCheckAt,
      gmailBaselineCompletedAt: preferences.gmailBaselineCompletedAt,
      csvCutoffs: exportCutoffs,
    });
  }
}
