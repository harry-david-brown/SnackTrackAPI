import type { Migration } from './Migration';

export const importObjectCleanupMigration: Migration = {
  version: 35,
  name: 'import_object_cleanup',
  statements: [
    `CREATE TABLE import_object_deletions (
       object_key TEXT PRIMARY KEY,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       retain_until TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
       attempts INTEGER NOT NULL DEFAULT 0,
       last_deleted_at TIMESTAMPTZ
     )`,
    `CREATE INDEX idx_import_object_deletions_due ON import_object_deletions(next_attempt_at)`,
    `CREATE FUNCTION preserve_deleted_import_object() RETURNS TRIGGER AS $$
     BEGIN
       IF OLD.object_key IS NOT NULL THEN
         INSERT INTO import_object_deletions(object_key) VALUES (OLD.object_key)
         ON CONFLICT (object_key) DO UPDATE SET
           retain_until=GREATEST(import_object_deletions.retain_until, NOW()+INTERVAL '24 hours'),
           next_attempt_at=LEAST(import_object_deletions.next_attempt_at, NOW());
       END IF;
       RETURN OLD;
     END;
     $$ LANGUAGE plpgsql`,
    `CREATE TRIGGER preserve_deleted_import_object BEFORE DELETE ON import_jobs
       FOR EACH ROW EXECUTE FUNCTION preserve_deleted_import_object()`,
  ],
};
