/// <reference types="node" />
import 'dotenv/config';
import type { Worker } from 'bullmq';
import logger from './config/logger';
import { config } from './config/AppConfig';
import { redisConfig, redisLockStore } from './config/redis';
import { container } from './services/core/ServiceContainer';
import { ImportJobProcessor } from './services/import/ImportJobProcessor';
import { ImportPushNotificationService } from './services/notifications/ImportPushNotificationService';
import { createQueueWorker, EXPORT_IMPORT_QUEUE, ImportQueuePublisher, MAILBOX_IMPORT_QUEUE, NOTIFICATION_QUEUE, OutboxDispatcher, type QueuePayload } from './services/queue/ImportQueues';

const queueConfig = config.getQueueConfig();
const processor = new ImportJobProcessor(container.importJobRepository, container.importObjectStorage, container.zipExtractor, container.csvImportUseCase, container.historicalGmailImportService, container.historicalOutlookImportService, container.manualTrackingCheckService, container.ongoingTrackingService);
const push = new ImportPushNotificationService(container.importJobRepository, container.pushDeviceRepository, config.getPushConfig().deliveryMode, logger);
const publisher = new ImportQueuePublisher(container.importJobRepository, queueConfig);
const dispatcher = new OutboxDispatcher(container.importJobRepository, publisher, logger);
let mailboxWorker: Worker<QueuePayload> | null = null;
let exportWorker: Worker<QueuePayload> | null = null;

const notificationWorker = createQueueWorker(NOTIFICATION_QUEUE, queueConfig.redisUrl, queueConfig.notificationConcurrency, (job) => push.notify(job.data.jobId));
const observe = (worker: Worker<QueuePayload>) => {
  worker.on('error', (error) => logger.error('Queue worker error', { operation: 'import_worker', queue: worker.name, error: error.message }));
  worker.on('failed', (job, error) => logger.warn('Queued task attempt failed', { operation: 'import_worker', jobId: job?.data.jobId, queue: worker.name, attempt: job?.attemptsMade, error: error.message }));
};
observe(notificationWorker);

const startLockDependentWorkers = async (): Promise<void> => {
  await redisLockStore.waitUntilReady();
  if (mailboxWorker || exportWorker) return;
  mailboxWorker = createQueueWorker(MAILBOX_IMPORT_QUEUE, queueConfig.redisUrl, queueConfig.mailboxConcurrency, (job) => processor.process(job));
  exportWorker = createQueueWorker(EXPORT_IMPORT_QUEUE, queueConfig.redisUrl, queueConfig.exportConcurrency, (job) => processor.process(job));
  observe(mailboxWorker);
  observe(exportWorker);
  logger.info('Lock-dependent import workers started', { operation: 'import_worker_start', mailboxConcurrency: queueConfig.mailboxConcurrency, exportConcurrency: queueConfig.exportConcurrency });
};

const unsubscribeRedis = redisLockStore.onStateChange((snapshot) => {
  const workers = [mailboxWorker, exportWorker].filter((worker): worker is Worker<QueuePayload> => worker !== null);
  if (snapshot.state === 'ready') {
    if (workers.length === 0) void startLockDependentWorkers();
    else for (const worker of workers) void worker.resume().catch((error) => logger.warn('Import worker resume failed', { operation: 'import_worker_resume', queue: worker.name, error }));
  } else if (snapshot.enabled) {
    for (const worker of workers) void worker.pause(true).catch((error) => logger.warn('Import worker pause failed', { operation: 'import_worker_pause', queue: worker.name, error }));
  }
});

void redisConfig.initialize();
void startLockDependentWorkers();
dispatcher.start();
void container.importObjectStorage.cleanupOrphanedTemporaryFiles()
  .then((removed) => { if (removed > 0) logger.info('Removed orphaned import temporary directories', { operation: 'import_temp_cleanup', removed }); })
  .catch((error) => logger.warn('Import temporary directory cleanup failed', { operation: 'import_temp_cleanup', error }));
logger.info('Import worker process started', { operation: 'import_worker_process_start', notificationConcurrency: queueConfig.notificationConcurrency });

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  unsubscribeRedis();
  logger.info('Import worker shutting down', { signal });
  await dispatcher.close();
  await Promise.all([mailboxWorker?.close(), exportWorker?.close(), notificationWorker.close()]);
  await publisher.close();
  await redisConfig.close();
  container.importObjectStorage.close();
  await container.postgres.close();
};
process.on('SIGTERM', () => void close('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => void close('SIGINT').then(() => process.exit(0)));
