import { Migration } from './Migration';

export const importJobEventsMigration: Migration = {
  version: 22,
  name: 'import_job_events',
  statements: [
    `CREATE TABLE IF NOT EXISTS import_job_events (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      event_type VARCHAR(48) NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL,
      phase VARCHAR(64) NOT NULL,
      progress INTEGER NOT NULL,
      error_code VARCHAR(100),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_import_job_events_job
      ON import_job_events(job_id,created_at DESC,id DESC)`,
    `INSERT INTO import_job_events(job_id,event_type,attempt,status,phase,progress,error_code,details,created_at)
      SELECT id,'migration_snapshot',attempts,status,phase,progress,error_code,'{}'::jsonb,updated_at
      FROM import_jobs
      WHERE NOT EXISTS (SELECT 1 FROM import_job_events event WHERE event.job_id=import_jobs.id)`,
  ],
};
