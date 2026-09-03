import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { AppConfig } from '../../config/AppConfig';
import type { ImportJobRepository, OutboxEvent } from '../data/ImportJobRepository';
import { queueForImportKind, type ImportJobKind } from '../import/ImportJobTypes';

export const MAILBOX_IMPORT_QUEUE = 'mailbox-imports';
export const EXPORT_IMPORT_QUEUE = 'export-imports';
export const NOTIFICATION_QUEUE = 'notifications';
export interface QueuePayload { readonly jobId: string }

const consumerConnection = (url: string): IORedis => new IORedis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
const producerConnection = (url: string): IORedis => new IORedis(url, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  enableOfflineQueue: false,
  connectTimeout: 5_000,
  retryStrategy: (attempt) => Math.min(30_000, Math.max(250, 250 * 2 ** Math.min(attempt, 7))),
});

type QueueSet = {
  readonly mailbox: Queue<QueuePayload>;
  readonly exports: Queue<QueuePayload>;
  readonly notifications: Queue<QueuePayload>;
};
const queuesFor = (connection: IORedis): QueueSet => ({
  mailbox: new Queue(MAILBOX_IMPORT_QUEUE, { connection }),
  exports: new Queue(EXPORT_IMPORT_QUEUE, { connection }),
  notifications: new Queue(NOTIFICATION_QUEUE, { connection }),
});

export class ImportQueuePublisher {
  private readonly connection: IORedis;
  private readonly queues: QueueSet;
  constructor(private readonly jobs: ImportJobRepository, queue: AppConfig['queue']) {
    this.connection = producerConnection(queue.redisUrl);
    this.queues = queuesFor(this.connection);
  }
  isReady(): boolean { return this.connection.status === 'ready'; }
  state(): string { return this.connection.status; }
  async publish(event: OutboxEvent): Promise<void> {
    if (!this.isReady()) throw new Error(`Queue Redis is ${this.connection.status}`);
    const job = await this.jobs.findById(event.jobId);
    if (!job || job.status === 'cancelled') return;
    const queue = event.eventType === 'notify'
      ? this.queues.notifications
      : queueForImportKind(job.kind) === MAILBOX_IMPORT_QUEUE ? this.queues.mailbox : this.queues.exports;
    await queue.add(event.eventType, { jobId: event.jobId }, {
      jobId: `${event.eventType}-${event.jobId}`,
      attempts: event.eventType === 'notify' ? 5 : 3,
      backoff: { type: 'exponential', delay: event.eventType === 'notify' ? 10_000 : 30_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 2_000 },
    });
    if (event.eventType === 'dispatch') await this.jobs.markQueued(event.jobId);
  }
  async waitingCount(): Promise<number | null> {
    if (!this.isReady()) return null;
    const [mailbox, exports] = await Promise.all([this.queues.mailbox.getWaitingCount(), this.queues.exports.getWaitingCount()]);
    return mailbox + exports;
  }
  async close(): Promise<void> {
    await Promise.all([this.queues.mailbox.close(), this.queues.exports.close(), this.queues.notifications.close()]);
    if (this.connection.status !== 'end') await this.connection.quit().catch(() => this.connection.disconnect());
  }
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastDepthLogAt = 0;
  constructor(private readonly jobs: ImportJobRepository, private readonly publisher: ImportQueuePublisher, private readonly logger: { info(message: string, metadata: Readonly<Record<string,unknown>>): void; warn(message: string, metadata: Readonly<Record<string,unknown>>): void }) {}
  start(intervalMs = 1_000): void { if (this.timer) return; this.timer = setInterval(() => void this.flush(), intervalMs); this.timer.unref(); void this.flush(); }
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const event of await this.jobs.claimOutbox()) {
        try { await this.publisher.publish(event); await this.jobs.markOutboxPublished(event.id); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); await this.jobs.markOutboxFailed(event.id, message); this.logger.warn('Import outbox publication failed', { operation: 'import_outbox_publish', eventId: event.id, jobId: event.jobId, error: message }); }
      }
      if (Date.now() - this.lastDepthLogAt >= 30_000) {
        this.lastDepthLogAt = Date.now();
        this.logger.info('Import queue depth sampled', { operation: 'import_queue_depth', waitingJobs: await this.publisher.waitingCount(), queueRedisState: this.publisher.state() });
      }
    } catch (error) { this.logger.warn('Import outbox dispatcher cycle failed', { operation: 'import_outbox_dispatch', error: error instanceof Error ? error.message : String(error) }); }
    finally { this.running = false; }
  }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.flush(); }
}

export interface QueueMetrics {
  readonly name: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly paused: boolean;
  readonly workers: number;
  readonly oldestWaitingAgeSeconds: number | null;
}

/** Read/admin boundary for BullMQ. PostgreSQL remains the durable authority. */
export class ImportQueueOperations {
  private readonly connection: IORedis;
  private readonly queues: QueueSet;
  constructor(queue: AppConfig['queue']) { this.connection = producerConnection(queue.redisUrl); this.queues = queuesFor(this.connection); }
  state(): string { return this.connection.status; }
  isReady(): boolean { return this.connection.status === 'ready'; }
  async metrics(): Promise<QueueMetrics[]> {
    if (!this.isReady()) return [];
    return Promise.all(Object.values(this.queues).map(async (queue) => {
      const [counts, paused, workers, oldest] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), queue.isPaused(), queue.getWorkersCount(), queue.getJobs(['waiting'], 0, 0, true),
      ]);
      const timestamp = oldest[0]?.timestamp;
      return { name: queue.name, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, paused, workers, oldestWaitingAgeSeconds: timestamp ? Math.max(0, Math.floor((Date.now() - timestamp) / 1000)) : null };
    }));
  }
  async removeDispatchJobs(jobs: readonly { id: string; kind: ImportJobKind }[]): Promise<number> {
    if (!this.isReady()) return 0;
    let removed = 0;
    for (const job of jobs) {
      const queue = queueForImportKind(job.kind) === MAILBOX_IMPORT_QUEUE ? this.queues.mailbox : this.queues.exports;
      removed += await queue.remove(`dispatch-${job.id}`);
    }
    return removed;
  }
  async close(): Promise<void> { await Promise.all(Object.values(this.queues).map((queue) => queue.close())); if (this.connection.status !== 'end') await this.connection.quit().catch(() => this.connection.disconnect()); }
}

export const createQueueWorker = (queueName: string, queueUrl: string, concurrency: number, processor: (job: Job<QueuePayload>) => Promise<void>): Worker<QueuePayload> => new Worker(queueName, processor, { connection: consumerConnection(queueUrl), concurrency, lockDuration: 10 * 60 * 1000, stalledInterval: 30_000, maxStalledCount: 1 });
