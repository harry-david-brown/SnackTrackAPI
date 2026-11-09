import { decodeReceiptImportOutcome } from './ReceiptImportOutcome';

export const IMPORT_JOB_KINDS = [
  'export_ready_check',
  'gmail_historical',
  'outlook_historical',
  'manual_tracking',
  'scheduled_tracking',
  'gmail_push_tracking',
  'export_file',
  'receipt_rebuild',
  'receipt_publish',
  'receipt_rollback',
] as const;
export type ImportJobKind = (typeof IMPORT_JOB_KINDS)[number];

export const IMPORT_JOB_STATUSES = [
  'awaiting_upload',
  'pending_dispatch',
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'expired',
  'superseded',
  'cancelled',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];
export type ImportJobTrigger = 'user' | 'scheduler';
export const IMPORT_JOURNEY_CONTEXTS = ['onboarding', 'post_onboarding', 'routine', 'legacy'] as const;
export type ImportJourneyContext = (typeof IMPORT_JOURNEY_CONTEXTS)[number];
export const isImportJourneyContext = (value: unknown): value is ImportJourneyContext =>
  typeof value === 'string' && IMPORT_JOURNEY_CONTEXTS.includes(value as ImportJourneyContext);
export const EXPORT_PROVIDERS = ['uber_eats', 'doordash'] as const;
export type ExportProvider = (typeof EXPORT_PROVIDERS)[number];

export interface ImportTimeEstimate {
  readonly kind: 'total' | 'remaining' | 'retry_wait' | 'finishing';
  readonly minimumMinutes: number | null;
  readonly maximumMinutes: number | null;
  readonly revision: number;
}

export interface ImportOperationPresentation {
  readonly mode: 'foreground' | 'delayed';
  readonly expectedDurationBand: 'under_5_minutes' | 'over_5_minutes' | 'unknown';
  readonly reason: 'normal' | 'queue_backlog' | 'workers_unavailable' | 'queue_paused' | 'retrying' | 'elapsed_over_threshold';
  readonly stage: 'waiting' | 'discovering' | 'building_history' | 'preparing_recap';
  readonly discoveredOrderCount: number | null;
  readonly timeEstimate: ImportTimeEstimate | null;
}

export interface ImportJob {
  readonly id: string;
  readonly userId: string;
  readonly kind: ImportJobKind;
  readonly trigger: ImportJobTrigger;
  readonly journeyContext: ImportJourneyContext;
  readonly status: ImportJobStatus;
  readonly phase: string;
  readonly progress: number;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly heartbeatAt: string | null;
  readonly objectKey: string | null;
  readonly originalFilename: string | null;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly exportProvider: ExportProvider | null;
  readonly objectEtag: string | null;
  readonly submittedContentType: string | null;
  readonly submittedContentLength: number | null;
  readonly importGeneration: number;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
}

export type ImportOperation = Omit<ImportJob,
  'userId' | 'heartbeatAt' | 'objectKey' | 'originalFilename' | 'contentType' | 'contentLength' |
  'exportProvider' | 'objectEtag' | 'submittedContentType' | 'submittedContentLength' |
  'importGeneration' | 'checkpoint' | 'expiresAt'> & {
  readonly provider: ExportProvider | null;
  readonly presentation: ImportOperationPresentation | null;
};

export interface ImportExecutionCheckpoint {
  /** Internal durable accounting identity, separate from provider cursor checkpoints. */
  readonly accountingJobId?: string;
  /** Cooperative cancellation at external-work and write boundaries. */
  assertActive?(): Promise<void>;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  save(checkpoint: Readonly<Record<string, unknown>>, phase: string, progress: number): Promise<void>;
}

export interface ImportOperationResponse {
  readonly operation: ImportOperation;
}

/** The only job projection allowed across the HTTP boundary. */
export const toImportOperation = (job: ImportJob): ImportOperation => ({
  id: job.id,
  kind: job.kind,
  trigger: job.trigger,
  journeyContext: job.journeyContext,
  status: job.status,
  phase: job.phase,
  progress: job.progress,
  result: job.result ? { ...job.result, ...(job.result.receiptOutcome === undefined ? {} : { receiptOutcome: decodeReceiptImportOutcome(job.result.receiptOutcome) }) } : null,
  errorCode: job.errorCode,
  errorMessage: job.errorMessage,
  attempts: job.attempts,
  provider: job.exportProvider,
  presentation: job.trigger === 'user' && ['gmail_historical', 'outlook_historical', 'export_file'].includes(job.kind)
    ? {
        mode: 'foreground',
        expectedDurationBand: 'unknown',
        reason: 'normal',
        stage: 'waiting',
        discoveredOrderCount: null,
        timeEstimate: null,
      }
    : null,
  createdAt: job.createdAt,
  queuedAt: job.queuedAt,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  updatedAt: job.updatedAt,
});

export const isActiveImportJob = (status: ImportJobStatus): boolean =>
  status === 'awaiting_upload' ||
  status === 'pending_dispatch' ||
  status === 'queued' ||
  status === 'running' ||
  status === 'retrying';

export const queueForImportKind = (
  kind: ImportJobKind,
): 'mailbox-imports' | 'export-imports' => (kind === 'export_file' ? 'export-imports' : 'mailbox-imports');
