import { Migration } from './Migration';

export const importJobCheckpointsMigration: Migration = {
  version: 13,
  name: 'import_job_checkpoints',
  statements: [
    `ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb`,
  ],
};
