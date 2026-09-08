import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportQueueOperations, QueueMetrics } from '../queue/ImportQueues';
import {
  isActiveImportJob,
  queueForImportKind,
  toImportOperation,
  type ImportJob,
  type ImportOperation,
  type ImportOperationPresentation,
  type ImportTimeEstimate,
} from './ImportJobTypes';
import { GMAIL_LONG_RUNNING_DELAY_MS, SIMULATED_LONG_RUNNING_ERROR_CODE } from './ImportTestScenarios';

const FIVE_MINUTES_SECONDS = 300;
const SNAPSHOT_TTL_MS = 15_000;

interface Snapshot {
  readonly capturedAt: number;
  readonly metrics: readonly QueueMetrics[];
}

export class ImportOperationPresentationService {
  private snapshot: Snapshot | null = null;

  constructor(
    private readonly jobs: Pick<ImportJobRepository, 'getP75DurationSeconds'>,
    private readonly queues: Pick<ImportQueueOperations, 'metrics'>,
    private readonly clock: () => number = Date.now,
  ) {}

  async forJob(job: ImportJob): Promise<ImportOperationPresentation | null> {
    if (
      job.trigger !== 'user' ||
      !['gmail_historical', 'outlook_historical', 'export_file'].includes(job.kind) ||
      !isActiveImportJob(job.status)
    ) return null;
    if (job.status === 'awaiting_upload') return this.foreground(job, 'unknown', null);

    const elapsedSeconds = Math.max(0, (this.clock() - new Date(job.createdAt).getTime()) / 1000);
    if (job.status === 'retrying' && job.kind === 'gmail_historical' && job.errorCode === SIMULATED_LONG_RUNNING_ERROR_CODE) {
      const delayElapsedSeconds = Math.max(0, (this.clock() - new Date(job.updatedAt).getTime()) / 1000);
      const delayRemainingSeconds = Math.max(0, GMAIL_LONG_RUNNING_DELAY_MS / 1000 - delayElapsedSeconds);
      const processingSeconds = 150 * Math.max(0.05, (100 - job.progress) / 100);
      return this.delayed(job, 'retrying', this.rangeEstimate(
        'remaining',
        delayRemainingSeconds + processingSeconds * 0.8,
        delayRemainingSeconds + processingSeconds * 1.2,
        job.attempts,
      ));
    }
    const queueName = queueForImportKind(job.kind);
    const metrics = (await this.queueMetrics()).find((candidate) => candidate.name === queueName);
    if (!metrics) {
      return elapsedSeconds >= FIVE_MINUTES_SECONDS
        ? this.delayed(job, 'elapsed_over_threshold', null)
        : this.foreground(job, 'unknown', null);
    }
    // A temporary retry, paused queue, or missing worker does not by itself mean
    // the operation will take more than five minutes. Keep showing live progress
    // until elapsed time or measurable queue depth supports that claim.
    if (metrics.paused || metrics.workers === 0) {
      return elapsedSeconds >= FIVE_MINUTES_SECONDS
        ? this.delayed(job, 'elapsed_over_threshold', null)
        : this.foreground(job, 'unknown', null);
    }

    const historicalDuration = await this.jobs.getP75DurationSeconds(queueName);
    const fallbackDuration = queueName === 'mailbox-imports' ? 150 : 180;
    const serviceSeconds = historicalDuration ?? fallbackDuration;
    const currentJobIsCounted = ['pending_dispatch', 'queued', 'running'].includes(job.status) ? 1 : 0;
    const jobsAhead = Math.max(0, metrics.waiting + metrics.active - currentJobIsCounted);
    const queueSeconds = (jobsAhead / metrics.workers) * serviceSeconds;
    const progressRemaining = Math.max(0.05, (100 - job.progress) / 100);
    const processingSeconds = serviceSeconds * progressRemaining;
    const retrySeconds = this.retryWaitSeconds(job);
    const projectedSeconds = queueSeconds + processingSeconds + retrySeconds.maximum;
    const estimate = this.timeEstimate(job, elapsedSeconds, queueSeconds + processingSeconds, retrySeconds);
    const isOverFiveMinutes = elapsedSeconds >= FIVE_MINUTES_SECONDS
      || (metrics.oldestWaitingAgeSeconds ?? 0) >= FIVE_MINUTES_SECONDS
      || elapsedSeconds + projectedSeconds > FIVE_MINUTES_SECONDS;
    return isOverFiveMinutes
      ? this.delayed(job, elapsedSeconds >= FIVE_MINUTES_SECONDS ? 'elapsed_over_threshold' : 'queue_backlog', estimate)
      : this.foreground(job, 'under_5_minutes', estimate);
  }

  async operation(job: ImportJob): Promise<ImportOperation> {
    return { ...toImportOperation(job), presentation: await this.forJob(job) };
  }

  private async queueMetrics(): Promise<readonly QueueMetrics[]> {
    const now = this.clock();
    if (this.snapshot && now - this.snapshot.capturedAt < SNAPSHOT_TTL_MS) return this.snapshot.metrics;
    const metrics = await this.queues.metrics().catch(() => []);
    this.snapshot = { capturedAt: now, metrics };
    return metrics;
  }

  private foreground(job: ImportJob, expectedDurationBand: 'under_5_minutes' | 'unknown', timeEstimate: ImportTimeEstimate | null): ImportOperationPresentation {
    return { mode: 'foreground', expectedDurationBand, reason: 'normal', timeEstimate, ...this.progressFor(job) };
  }

  private delayed(job: ImportJob, reason: Exclude<ImportOperationPresentation['reason'], 'normal'>, timeEstimate: ImportTimeEstimate | null): ImportOperationPresentation {
    return { mode: 'delayed', expectedDurationBand: 'over_5_minutes', reason, timeEstimate, ...this.progressFor(job) };
  }

  private retryWaitSeconds(job: ImportJob): { readonly minimum: number; readonly maximum: number } {
    if (job.status !== 'retrying' || job.kind !== 'gmail_historical' || job.errorCode !== 'GMAIL_RATE_LIMITED') {
      return { minimum: 0, maximum: 0 };
    }
    const retryNumber = Math.max(0, job.attempts - 1);
    const maximumDelay = 90 * 2 ** retryNumber;
    const minimumDelay = maximumDelay * 0.8;
    const waitingSeconds = Math.max(0, (this.clock() - new Date(job.updatedAt).getTime()) / 1000);
    return {
      minimum: Math.max(0, minimumDelay - waitingSeconds),
      maximum: Math.max(0, maximumDelay - waitingSeconds),
    };
  }

  private timeEstimate(
    job: ImportJob,
    elapsedSeconds: number,
    processingSeconds: number,
    retrySeconds: { readonly minimum: number; readonly maximum: number },
  ): ImportTimeEstimate {
    if (retrySeconds.maximum > 0) {
      return this.rangeEstimate('retry_wait', retrySeconds.minimum, retrySeconds.maximum, job.attempts);
    }
    if (job.progress >= 90 || processingSeconds <= 45) {
      return { kind: 'finishing', minimumMinutes: null, maximumMinutes: null, revision: job.attempts };
    }
    const kind = elapsedSeconds < 20 && job.progress <= 10 ? 'total' : 'remaining';
    return this.rangeEstimate(kind, processingSeconds * 0.8, processingSeconds * 1.2, job.attempts);
  }

  private rangeEstimate(
    kind: Exclude<ImportTimeEstimate['kind'], 'finishing'>,
    minimumSeconds: number,
    maximumSeconds: number,
    revision: number,
  ): ImportTimeEstimate {
    const minimumMinutes = Math.max(1, Math.floor(minimumSeconds / 60));
    const maximumMinutes = Math.max(minimumMinutes, Math.ceil(maximumSeconds / 60));
    return { kind, minimumMinutes, maximumMinutes, revision };
  }

  private progressFor(job: ImportJob): Pick<ImportOperationPresentation, 'stage' | 'discoveredOrderCount'> {
    const counters = job.checkpoint.counters;
    const supportedReceiptsFound = counters && typeof counters === 'object' && !Array.isArray(counters)
      ? Number((counters as Readonly<Record<string, unknown>>).supportedReceiptsFound)
      : Number.NaN;
    const discoveredOrderCount = Number.isFinite(supportedReceiptsFound) && supportedReceiptsFound >= 0
      ? Math.floor(supportedReceiptsFound)
      : null;

    if (job.status === 'awaiting_upload' || job.status === 'pending_dispatch' || job.status === 'queued' || job.status === 'retrying') {
      return { stage: 'waiting', discoveredOrderCount };
    }
    if (job.phase === 'finalizing' || job.phase === 'mailbox_imported') {
      return { stage: 'preparing_recap', discoveredOrderCount };
    }
    if (job.phase === 'importing' || (discoveredOrderCount !== null && discoveredOrderCount > 0)) {
      return { stage: 'building_history', discoveredOrderCount };
    }
    return { stage: 'discovering', discoveredOrderCount };
  }
}
