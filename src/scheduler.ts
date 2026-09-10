/// <reference types="node" />
import 'dotenv/config';
import logger from './config/logger';
import { container } from './services/core/ServiceContainer';
import { ImportPushNotificationService } from './services/notifications/ImportPushNotificationService';
import { config } from './config/AppConfig';

const run = async (): Promise<void> => {
  try {
    const expiredUploads = await container.importJobRepository.expireUploads();
    const cleanupCandidates = await container.importJobRepository.listObjectCleanupCandidates();
    let cleanedUploadObjects = 0;
    for (const candidate of cleanupCandidates) {
      try {
        await container.importObjectStorage.delete(candidate.objectKey);
        await container.importJobRepository.markObjectDeleted(candidate.jobId, candidate.objectKey);
        cleanedUploadObjects += 1;
      } catch (error) {
        logger.warn('Expired import object cleanup failed', { operation: 'import_object_cleanup', jobId: candidate.jobId, error });
      }
    }
    const recoveredJobs = await container.importJobRepository.recoverStaleJobs();
    const gmailPush = await container.gmailPushMaintenanceService.run(500);
    const outlookTracking = await container.scheduledImportJobService.enqueueEligible(500);
    await container.gmailUnitBudgetRepository.cleanup();
    const pushReceipts = await new ImportPushNotificationService(
      container.importJobRepository,
      container.pushDeviceRepository,
      config.getPushConfig().deliveryMode,
      logger,
    ).processReceipts();
    logger.info('Import scheduler completed', {
      operation: 'import_scheduler', expiredUploads, cleanedUploadObjects, recoveredJobs,
      pushReceipts, gmailPush, outlookTracking,
    });
  } finally {
    container.importObjectStorage.close();
    await container.postgres.close();
  }
};

void run().catch((error) => {
  logger.error('Import scheduler failed', { operation: 'import_scheduler', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
