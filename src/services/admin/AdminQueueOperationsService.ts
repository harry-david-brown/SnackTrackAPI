import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportQueueOperations } from '../queue/ImportQueues';
import type { RedisLifecycleSnapshot } from '../../config/redis';

export class AdminQueueOperationsService {
  constructor(
    private readonly jobs: ImportJobRepository,
    private readonly queues: ImportQueueOperations,
    private readonly lockRedis: { snapshot(): RedisLifecycleSnapshot },
  ) {}

  async status() {
    const durable = await this.jobs.operationalSnapshot();
    let queueMetrics = [] as Awaited<ReturnType<ImportQueueOperations['metrics']>>;
    let queueState = this.queues.state();
    if (this.queues.isReady()) {
      try { queueMetrics = await this.queues.metrics(); }
      catch { queueState = 'unavailable'; }
    }
    const durableActive = ['pending_dispatch', 'queued', 'running', 'retrying']
      .reduce((total, status) => total + (durable.statuses[status] ?? 0), 0);
    const redisActive = queueMetrics
      .filter((queue) => queue.name !== 'notifications')
      .reduce((total, queue) => total + queue.waiting + queue.active + queue.delayed, 0);
    return {
      timestamp: new Date().toISOString(),
      redis: { cacheAndLocks: this.lockRedis.snapshot(), queue: { state: queueState } },
      queues: queueMetrics,
      durable,
      discrepancy: {
        durableActiveJobs: durableActive,
        redisVisibleJobs: redisActive,
        difference: durableActive - redisActive,
      },
    };
  }

  async cancelPending(input: { actorAdminId: string; reason: string; requestId?: string }) {
    const cancelled = await this.jobs.cancelPending(input);
    let removedRedisJobs = 0;
    let redisCleanupDeferred = !this.queues.isReady();
    if (!redisCleanupDeferred) {
      try { removedRedisJobs = await this.queues.removeDispatchJobs(cancelled); }
      catch { redisCleanupDeferred = true; }
    }
    return { cancelledDurableJobs: cancelled.length, removedRedisJobs, redisCleanupDeferred };
  }

  close(): Promise<void> { return this.queues.close(); }
}
