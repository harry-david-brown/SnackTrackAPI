import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportQueueOperations, QueueMetrics } from '../queue/ImportQueues';
import {
  isActiveImportJob,
  queueForImportKind,
  toImportOperation,
  type ImportJob,
  type ImportOperation,
  type ImportOperationPresentation,
} from './ImportJobTypes';

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
    if (job.status === 'awaiting_upload') return this.foreground(job, 'unknown');

    const elapsedSeconds = Math.max(0, (this.clock() - new Date(job.createdAt).getTime()) / 1000);
    if (elapsedSeconds >= FIVE_MINUTES_SECONDS) {
      return this.delayed(job, 'elapsed_over_threshold');
    }
    if (job.status === 'retrying') return this.delayed(job, 'retrying');

    const queueName = queueForImportKind(job.kind);
    const metrics = (await this.queueMetrics()).find((candidate) => candidate.name === queueName);
    if (!metrics) return this.foreground(job, 'unknown');
    if (metrics.paused) return this.delayed(job, 'queue_paused');
    if (metrics.workers === 0 && elapsedSeconds >= 15) return this.delayed(job, 'workers_unavailable');
    if (metrics.workers === 0) return this.foreground(job, 'unknown');
    if ((metrics.oldestWaitingAgeSeconds ?? 0) >= FIVE_MINUTES_SECONDS) return this.delayed(job, 'queue_backlog');

    const historicalDuration = await this.jobs.getP75DurationSeconds(queueName);
    const fallbackDuration = queueName === 'mailbox-imports' ? 90 : 180;
    const serviceSeconds = historicalDuration ?? fallbackDuration;
    const projectedSeconds = ((metrics.waiting + metrics.active + 1) / metrics.workers) * serviceSeconds;
    return projectedSeconds > FIVE_MINUTES_SECONDS
      ? this.delayed(job, 'queue_backlog')
      : this.foreground(job, 'under_5_minutes');
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

  private foreground(job: ImportJob, expectedDurationBand: 'under_5_minutes' | 'unknown'): ImportOperationPresentation {
    return { mode: 'foreground', expectedDurationBand, reason: 'normal', ...this.progressFor(job) };
  }

  private delayed(job: ImportJob, reason: Exclude<ImportOperationPresentation['reason'], 'normal'>): ImportOperationPresentation {
    return { mode: 'delayed', expectedDurationBand: 'over_5_minutes', reason, ...this.progressFor(job) };
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
