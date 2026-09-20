import { AppError, ConflictError } from '../../core/errors';
import { ReceiptType } from '../../models/Receipt';
import { CURRENT_UBER_EXPORT_PARSER_VERSION } from '../../models/OrderEvidence';
import type { ExportProvider } from '../import/ImportLifecycleTypes';
import type { ReceiptWriterLockPort } from '../ports/ImportPorts';
import type {
  ReceiptRepairAccountPort,
  RetainedReceiptSourceReadPort,
} from '../ports/ReceiptRepairAcquisitionPorts';
import { summarizeOrderMetrics } from '../analytics/shared/orderMetrics';
import { evidenceFingerprint, receiptDocumentKey } from './ReceiptEvidenceFingerprint';
import { reconcileReceiptGroups, projectReconciledGroup } from './ReceiptGroupReconciler';
import { decodeRetainedEmailDiagnostics, type ReceiptRepairSourcePort, type RepairSourceProvenance } from './ReceiptRepairSources';
import type { MailboxProvider } from '../mailbox/MailboxConnection';

interface ReceiptRepairCommand {
  userId: string;
  provider: ExportProvider;
  path: string;
  acquiredAt: string;
  stage?: { expectedGeneration: number; expectedFingerprint: string };
}
export type ReceiptRepairSourceCommand = ReceiptRepairCommand & (
  { sourceKind: 'provider_export' } | { sourceKind: 'retained_email'; mailboxProvider: MailboxProvider }
);

/** Acquisition only: no serving receipts, coverage, caches, jobs or mailbox access are changed. */
export class ReceiptRepairSourceAcquisition {
  constructor(
    private readonly accounts: ReceiptRepairAccountPort,
    private readonly reader: RetainedReceiptSourceReadPort,
    private readonly sources: ReceiptRepairSourcePort,
    private readonly locks: ReceiptWriterLockPort,
  ) {}

  async execute(command: ReceiptRepairSourceCommand) {
    if (
      !['provider_export', 'retained_email'].includes(command.sourceKind) ||
      (command.sourceKind === 'retained_email' && !['gmail', 'microsoft'].includes(command.mailboxProvider)) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(command.userId) ||
      !['uber_eats', 'doordash'].includes(command.provider) ||
      !command.path ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(command.acquiredAt) ||
      !Number.isFinite(Date.parse(command.acquiredAt)) ||
      new Date(command.acquiredAt).toISOString() !== command.acquiredAt
    )
      throw new AppError({
        code: 'INVALID_REPAIR_ACQUISITION',
        message: 'Invalid retained source acquisition input',
      });
    if (
      command.stage &&
      (!Number.isSafeInteger(command.stage.expectedGeneration) ||
        command.stage.expectedGeneration < 0 ||
        !/^[a-f0-9]{64}$/.test(command.stage.expectedFingerprint))
    )
      throw new AppError({
        code: 'INVALID_REPAIR_ACQUISITION',
        message: 'Staging requires the reviewed preview fingerprint and generation',
      });
    // The account must exist before reading private source contents. Preview performs reads only.
    const context = await this.accounts.getContext(command.userId);
    if (!context)
      throw new AppError({ code: 'NOT_FOUND', message: 'Repair account was not found' });
    if (command.stage && command.stage.expectedGeneration !== context.generation)
      throw new ConflictError(
        'REPAIR_GENERATION_STALE',
        'Account generation changed; preview the source again',
      );
    const acquired = await this.reader.read({
      sourceKind: command.sourceKind,
      ...(command.sourceKind === 'retained_email' ? {mailboxProvider:command.mailboxProvider} : {}),
      userId: command.userId,
      provider: command.provider,
      path: command.path,
      timezone: context.timezone,
    });
    const emailDiagnostics = acquired.emailDiagnostics === undefined ? undefined : decodeRetainedEmailDiagnostics(acquired.emailDiagnostics);
    if (!/^[a-f0-9]{64}$/.test(acquired.artifact.sha256) || !Number.isSafeInteger(acquired.artifact.sizeBytes) || acquired.artifact.sizeBytes <= 0 ||
      !Number.isSafeInteger(acquired.rejectedRecords) || acquired.rejectedRecords < 0 || typeof acquired.successfulCompletion !== 'boolean' ||
      (command.sourceKind === 'retained_email' && (!emailDiagnostics || emailDiagnostics.mailboxProvider !== command.mailboxProvider ||
        emailDiagnostics.acceptedMessages !== acquired.receipts.length || Object.values(emailDiagnostics.rejected).reduce((a,b)=>a+b,0) !== acquired.rejectedRecords)) ||
      (command.sourceKind === 'provider_export' && emailDiagnostics)) throw new AppError({code:'INVALID_REPAIR_ACQUISITION', message:'Invalid retained source reader result'});
    const documents = [
      ...new Map(
        acquired.receipts.map((receipt) => [receiptDocumentKey(receipt), receipt]),
      ).entries(),
    ].sort(([a], [b]) => a.localeCompare(b));
    if (
      documents.some(
        ([, r]) =>
          r.userId !== command.userId ||
          r.receiptType !== command.provider ||
          r.dataSource !== (command.sourceKind === 'provider_export' ? 'csv' : 'email') ||
          (command.sourceKind === 'retained_email' && !r.resolution?.sourceMessageId?.startsWith(`${command.mailboxProvider}:`)) ||
          r.resolution?.orderEvidence?.parserVersion !==
            (command.sourceKind === 'provider_export' && command.provider === 'uber_eats'
              ? CURRENT_UBER_EXPORT_PARSER_VERSION
              : 3),
      )
    )
      throw new AppError({
        code: 'INVALID_REPAIR_ACQUISITION',
        message: 'Source reader returned incompatible receipt evidence',
      });
    const provenance: RepairSourceProvenance = {
      sourceKind: command.sourceKind,
      provider: command.provider === 'uber_eats' ? ReceiptType.UBER_EATS : ReceiptType.DOORDASH,
      sourceLabel: command.sourceKind === 'provider_export'
        ? command.provider === 'uber_eats' ? 'Retained Uber Eats export' : 'Retained DoorDash export'
        : `Retained ${command.mailboxProvider === 'gmail' ? 'Gmail' : 'Outlook'} ${command.provider === 'uber_eats' ? 'Uber Eats' : 'DoorDash'} messages`,
      acquiredAt: new Date(command.acquiredAt).toISOString(),
      successfulCompletion: acquired.successfulCompletion,
      rejectedRecords: acquired.rejectedRecords,
      artifact: acquired.artifact,
      parsingTimezone: context.timezone,
      ...(emailDiagnostics ? {emailDiagnostics} : {}),
    };
    const fingerprint = evidenceFingerprint({
      userId: command.userId,
      ...context,
      policyVersion: 3,
      provenance,
      documents,
    });
    const dates = documents
      .map(([, r]) => r.orderDate?.toISOString())
      .filter((d): d is string => !!d)
      .sort();
    const groups = reconcileReceiptGroups(
      documents.map(([id, receipt]) => ({ id, receipt })),
      context.timezone,
      [],
      3,
    );
    const report = {
      scope: command.sourceKind === 'provider_export' ? 'retained_export_only' as const : 'retained_email_only' as const,
      userId: command.userId,
      ...context,
      policyVersion: 3 as const,
      acquiredAt: provenance.acquiredAt,
      fingerprint,
      artifact: acquired.artifact,
      sourceDocuments: documents.length,
      rejectedRecords: acquired.rejectedRecords,
      successfulCompletion: acquired.successfulCompletion,
      ...(emailDiagnostics ? {emailDiagnostics, observedOrderDates: dates.length ? {start:dates[0],end:dates[dates.length-1]} : null} : {}),
      observedCoverage: command.sourceKind === 'provider_export' && dates.length
        ? { start: dates[0], end: dates[dates.length - 1], quality: 'observed' as const }
        : null,
      orderMetrics: summarizeOrderMetrics(
        groups.map((g, i) => projectReconciledGroup(g, `preview-${i}`)),
      ),
    };
    if (!command.stage) return { mode: 'preview' as const, ...report };
    if (fingerprint !== command.stage.expectedFingerprint)
      throw new ConflictError(
        'REPAIR_PREVIEW_CHANGED',
        'Retained source or parsing context changed; preview it again',
      );
    if (!documents.length)
      throw new AppError({
        code: command.sourceKind === 'provider_export' ? 'NO_VALID_EXPORT_ORDERS' : 'NO_VALID_RETAINED_RECEIPTS',
        message: 'There is no usable evidence to stage',
      });
    const lock = await this.locks.acquireLock(command.userId);
    if (!lock)
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'Another import or repair is already in progress',
      );
    try {
      // A separate operator process cannot safely coordinate through a process-local lock.
      if (lock.userId !== command.userId || lock.backend !== 'redis')
        throw new ConflictError(
          'REPAIR_DISTRIBUTED_LOCK_REQUIRED',
          'Retained source staging requires the shared distributed writer lock',
        );
      const staged = await this.sources.stageRepairSources(
        command.userId,
        context.generation,
        documents.map(([, receipt]) => receipt),
        provenance,
        () => this.locks.assertLockOwned(lock),
      );
      return { mode: 'staged' as const, ...report, staged };
    } finally {
      await this.locks.releaseLock(lock);
    }
  }
}
