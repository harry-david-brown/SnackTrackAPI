import { AppError } from '../../core/errors';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';

export interface MailboxImportCounters {
  pages: number;
  matchedMessages: number;
  emailsExamined: number;
  receiptsProcessed: number;
  supportedReceiptsFound: number;
  exportCoveredReceipts: number;
  eligibleReceipts: number;
  deduplicatedReceipts: number;
  totalReceiptsImported: number;
  totalAmount: number;
  errorCount: number;
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
  rejectedMessages: number;
  decodedBytesExamined: number;
}

export interface MailboxImportState {
  readonly provider: 'gmail' | 'microsoft';
  readonly version: 1;
  readonly cursor: string | null;
  readonly done: boolean;
  readonly estimatedTotalMessages?: number;
  readonly counters: MailboxImportCounters;
}

export const emptyMailboxCounters = (): MailboxImportCounters => ({
  pages: 0,
  matchedMessages: 0,
  emailsExamined: 0,
  receiptsProcessed: 0,
  supportedReceiptsFound: 0,
  exportCoveredReceipts: 0,
  eligibleReceipts: 0,
  deduplicatedReceipts: 0,
  totalReceiptsImported: 0,
  totalAmount: 0,
  errorCount: 0,
  newOrders: 0,
  updatedOrders: 0,
  unchangedOrders: 0,
  rejectedMessages: 0,
  decodedBytesExamined: 0,
});

const nonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export const restoreMailboxCheckpoint = (
  execution: ImportExecutionCheckpoint | undefined,
  provider: MailboxImportState['provider'],
): MailboxImportState => {
  if (!execution || Object.keys(execution.checkpoint).length === 0) {
    return { provider, version: 1, cursor: null, done: false, counters: emptyMailboxCounters() };
  }
  const raw = execution.checkpoint;
  const counters = raw.counters;
  const estimatedTotalMessages = raw.estimatedTotalMessages;
  if (
    raw.provider !== provider ||
    raw.version !== 1 ||
    typeof raw.done !== 'boolean' ||
    !('cursor' in raw) ||
    (raw.cursor !== null && typeof raw.cursor !== 'string') ||
    (estimatedTotalMessages !== undefined &&
      (typeof estimatedTotalMessages !== 'number' ||
        !Number.isInteger(estimatedTotalMessages) ||
        estimatedTotalMessages < 0)) ||
    typeof counters !== 'object' ||
    counters === null ||
    Array.isArray(counters)
  ) {
    throw new AppError({
      code: 'IMPORT_CHECKPOINT_INVALID',
      message: `Invalid ${provider} import checkpoint`,
      publicMessage: 'This import could not be resumed safely. Start a new import.',
    });
  }
  const restored = emptyMailboxCounters();
  for (const key of Object.keys(restored) as Array<keyof MailboxImportCounters>) {
    const value = nonNegativeNumber((counters as Record<string, unknown>)[key]);
    if (value === null) {
      throw new AppError({
        code: 'IMPORT_CHECKPOINT_INVALID',
        message: `Invalid ${provider} import checkpoint counter: ${key}`,
        publicMessage: 'This import could not be resumed safely. Start a new import.',
      });
    }
    restored[key] = value;
  }
  return {
    provider,
    version: 1,
    cursor: raw.cursor as string | null,
    done: raw.done,
    ...(estimatedTotalMessages !== undefined
      ? { estimatedTotalMessages: estimatedTotalMessages as number }
      : {}),
    counters: restored,
  };
};

export const checkpointProgress = (
  pages: number,
  processedMessages?: number,
  estimatedTotalMessages?: number,
): number => {
  if (
    processedMessages !== undefined &&
    estimatedTotalMessages !== undefined &&
    estimatedTotalMessages > 0
  ) {
    const completionRatio = Math.min(1, Math.max(0, processedMessages) / estimatedTotalMessages);
    return Math.min(89, 15 + Math.round(completionRatio * 74));
  }
  return Math.min(89, 15 + Math.max(0, pages) * 2);
};

export const saveMailboxCheckpoint = async (
  execution: ImportExecutionCheckpoint | undefined,
  state: MailboxImportState,
  estimatedTotalMessages?: number,
): Promise<void> => {
  if (!execution) return;
  const totalMessages = estimatedTotalMessages ?? state.estimatedTotalMessages;
  const checkpoint = totalMessages === undefined
    ? state
    : { ...state, estimatedTotalMessages: totalMessages };
  await execution.save(
    checkpoint as unknown as Readonly<Record<string, unknown>>,
    state.done ? 'mailbox_imported' : 'importing_mailbox',
    state.done ? 90 : checkpointProgress(
      state.counters.pages,
      state.counters.matchedMessages,
      totalMessages,
    ),
  );
};
