/// <reference types="node" />
import 'dotenv/config';
import logger from './config/logger';
import { config } from './config/AppConfig';
import { container } from './services/core/ServiceContainer';
import { ImportJobProcessor } from './services/import/ImportJobProcessor';
import { ImportPushNotificationService } from './services/notifications/ImportPushNotificationService';
import {
  createQueueWorker,
  EXPORT_IMPORT_QUEUE,
  ImportQueuePublisher,
  MAILBOX_IMPORT_QUEUE,
  NOTIFICATION_QUEUE,
  OutboxDispatcher,
} from './services/queue/ImportQueues';

const queueConfig = config.getQueueConfig();
const processor = new ImportJobProcessor(
  container.importJobRepository,
  container.importObjectStorage,
  container.zipExtractor,
  container.csvImportUseCase,
  container.historicalGmailImportService,
  container.historicalOutlookImportService,
  container.manualTrackingCheckService,
  container.ongoingTrackingService,
);
const push = new ImportPushNotificationService(
  container.importJobRepository,
  container.pushDeviceRepository,
  config.getPushConfig().deliveryMode,
  logger,
);
const publisher = new ImportQueuePublisher(container.importJobRepository, queueConfig);
const dispatcher = new OutboxDispatcher(container.importJobRepository, publisher, logger);

void container.importObjectStorage.cleanupOrphanedTemporaryFiles()
  .then((removed) => {
    if (removed > 0) logger.info('Removed orphaned import temporary directories', { operation: 'import_temp_cleanup', removed });
  })
  .catch((error) => logger.warn('Import temporary directory cleanup failed', { operation: 'import_temp_cleanup', error }));

const mailboxWorker = createQueueWorker(
  MAILBOX_IMPORT_QUEUE,
  queueConfig.redisUrl,
  queueConfig.mailboxConcurrency,
  (job) => processor.process(job),
);
const exportWorker = createQueueWorker(
  EXPORT_IMPORT_QUEUE,
  queueConfig.redisUrl,
  queueConfig.exportConcurrency,
  (job) => processor.process(job),
);
const notificationWorker = createQueueWorker(
  NOTIFICATION_QUEUE,
  queueConfig.redisUrl,
  queueConfig.notificationConcurrency,
  (job) => push.notify(job.data.jobId),
);

for (const worker of [mailboxWorker, exportWorker, notificationWorker]) {
  worker.on('error', (error) => logger.error('Queue worker error', { operation: 'import_worker', error: error.message }));
  worker.on('failed', (job, error) => logger.warn('Queued task attempt failed', { operation: 'import_worker', jobId: job?.data.jobId, queue: worker.name, attempt: job?.attemptsMade, error: error.message }));
}

dispatcher.start();
logger.info('Import workers started', {
  operation: 'import_worker_start',
  mailboxConcurrency: queueConfig.mailboxConcurrency,
  exportConcurrency: queueConfig.exportConcurrency,
  notificationConcurrency: queueConfig.notificationConcurrency,
});

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  logger.info('Import worker shutting down', { signal });
  await dispatcher.close();
  await Promise.all([mailboxWorker.close(), exportWorker.close(), notificationWorker.close()]);
  await publisher.close();
  container.importObjectStorage.close();
  await container.postgres.close();
};
process.on('SIGTERM', () => void close('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => void close('SIGINT').then(() => process.exit(0)));
