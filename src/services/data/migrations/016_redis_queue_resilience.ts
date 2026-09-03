import { Migration } from './Migration';

export const redisQueueResilienceMigration: Migration = {
  version: 16,
  name: 'redis_queue_resilience',
  statements: [
    `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
      CHECK (status IN ('awaiting_upload','pending_dispatch','queued','running','retrying','succeeded','failed','expired','superseded','cancelled'))`,
  ],
};
