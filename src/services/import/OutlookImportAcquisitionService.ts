import { AppError } from '../../core/errors';
import type { MicrosoftMailboxConnectionPort } from '../ports/ImportPorts';
import type { ReceiptType } from '../../models/Receipt';
import type { MicrosoftGraphMailboxClient } from '../mailbox/MicrosoftGraphMailboxClient';
import type { MailboxMessagePage } from '../ports/MailboxPorts';
import type { ImportPreferences } from './ImportLifecycleTypes';
import { resolveIncrementalGmailSearchAfter } from './GmailImportAcquisitionService';

type ExportCutoffs = Partial<Record<ReceiptType, Date>>;

interface ReceiptCutoffPort {
  getLatestCsvReceiptDates(userId: string): Promise<ExportCutoffs>;
}

interface PreferencesPort {
  get(userId: string): Promise<ImportPreferences>;
}
interface MailboxSecurityPolicyPort {
  get(userId: string): Promise<{ readonly allowForwardedReceipts: boolean }>;
}

export interface OutlookAcquisitionResult {
  readonly pages: AsyncIterable<MailboxMessagePage>;
  readonly exportCutoffs: ExportCutoffs;
  readonly searchAfter: Date | undefined;
}

export class OutlookImportAcquisitionService {
  constructor(
    private readonly connections: Pick<
      MicrosoftMailboxConnectionPort,
      'findMicrosoft' | 'getMicrosoftImportState'
    >,
    private readonly graph: Pick<MicrosoftGraphMailboxClient, 'getEmailPages'>,
    private readonly receipts: ReceiptCutoffPort,
    private readonly preferences: PreferencesPort,
    private readonly securityPolicies: MailboxSecurityPolicyPort,
  ) {}

  async acquire(
    userId: string,
    trigger: 'manual' | 'background',
    cursor?: string,
  ): Promise<OutlookAcquisitionResult> {
    const [connection, importState, exportCutoffs, preferences, safety] = await Promise.all([
      this.connections.findMicrosoft(userId),
      this.connections.getMicrosoftImportState(userId),
      this.receipts.getLatestCsvReceiptDates(userId),
      this.preferences.get(userId),
      this.securityPolicies.get(userId),
    ]);
    if (!connection || connection.state === 'reconnect_required') {
      throw new AppError({
        code: 'OUTLOOK_RECONNECT_REQUIRED',
        message: 'User does not have a usable Outlook connection',
        publicMessage: 'Reconnect Outlook to continue.',
      });
    }
    const searchAfter =
      trigger === 'background'
        ? resolveIncrementalGmailSearchAfter({
            lastSuccessfulCheckAt: preferences.lastSuccessfulCheckAt,
            gmailBaselineCompletedAt: importState.baselineCompletedAt,
            csvCutoffs: exportCutoffs,
          })
        : undefined;
    return {
      pages: this.graph.getEmailPages(connection, { after: searchAfter, cursor, safety }),
      exportCutoffs,
      searchAfter,
    };
  }
}
