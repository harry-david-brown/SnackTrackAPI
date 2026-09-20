import type { Migration } from './Migration';

/** The baseline and page membership commit with receipts, independently of mailbox cursors. */
export const receiptImportOutcomesMigration: Migration = {
  version: 29,
  name: 'receipt_import_outcomes',
  statements: [
    `ALTER TABLE gmail_sync_runs ADD COLUMN receipt_outcome JSONB CHECK(receipt_outcome IS NULL OR jsonb_typeof(receipt_outcome)='object')`,
    `ALTER TABLE mailbox_sync_runs ADD COLUMN receipt_outcome JSONB CHECK(receipt_outcome IS NULL OR jsonb_typeof(receipt_outcome)='object')`,
    // Historical operation identifiers intentionally survive routine job retention cleanup.
    `ALTER TABLE gmail_sync_runs ADD COLUMN import_job_id UUID`,
    `ALTER TABLE mailbox_sync_runs ADD COLUMN import_job_id UUID`,
    `CREATE UNIQUE INDEX gmail_sync_run_import_job ON gmail_sync_runs(user_id,import_job_id) WHERE import_job_id IS NOT NULL`,
    `CREATE UNIQUE INDEX mailbox_sync_run_import_job ON mailbox_sync_runs(user_id,provider,import_job_id) WHERE import_job_id IS NOT NULL`,
    `ALTER TABLE import_jobs ADD COLUMN receipt_outcome_state JSONB
      CHECK(receipt_outcome_state IS NULL OR COALESCE((
        jsonb_typeof(receipt_outcome_state)='object' AND
        receipt_outcome_state->'version'='1'::jsonb AND
        receipt_outcome_state->'policyVersion'='3'::jsonb AND
        jsonb_typeof(receipt_outcome_state->'baseline')='array' AND
        jsonb_typeof(receipt_outcome_state->'scopes')='object' AND
        jsonb_typeof(receipt_outcome_state->'importedObservationIds')='array' AND
        jsonb_typeof(receipt_outcome_state->'affectedObservationIds')='array' AND
        jsonb_typeof(receipt_outcome_state->'affectedReceiptIds')='array'),FALSE))`,
    `CREATE FUNCTION preserve_receipt_import_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE phase text;
      BEGIN
        IF NEW.status IN ('succeeded','cancelled','expired','superseded') THEN
          NEW.receipt_outcome_state=NULL;
        ELSIF OLD.receipt_outcome_state IS NOT NULL AND NEW.receipt_outcome_state IS NULL AND
          NEW.status IN ('running','retrying','pending_dispatch','queued','awaiting_upload','failed') AND
          EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND import_generation=NEW.import_generation) THEN
          RAISE EXCEPTION 'Active receipt import baseline cannot be cleared';
        ELSIF OLD.receipt_outcome_state IS NOT NULL AND NEW.receipt_outcome_state IS NOT NULL AND
          (OLD.receipt_outcome_state->'baseline' IS DISTINCT FROM NEW.receipt_outcome_state->'baseline' OR
           OLD.receipt_outcome_state->'version' IS DISTINCT FROM NEW.receipt_outcome_state->'version' OR
           OLD.receipt_outcome_state->'policyVersion' IS DISTINCT FROM NEW.receipt_outcome_state->'policyVersion') THEN
          RAISE EXCEPTION 'Receipt import baseline is immutable';
        END IF;
        IF OLD.receipt_outcome_state IS NOT NULL AND NEW.receipt_outcome_state IS NOT NULL THEN
          FOR phase IN SELECT jsonb_object_keys(OLD.receipt_outcome_state->'scopes') LOOP
            IF OLD.receipt_outcome_state->'scopes'->phase->'baseline' IS DISTINCT FROM
               NEW.receipt_outcome_state->'scopes'->phase->'baseline' THEN
              RAISE EXCEPTION 'Receipt import phase baseline is immutable';
            END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_import_baseline_immutable BEFORE UPDATE ON import_jobs
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_import_baseline()`,
    `CREATE FUNCTION clear_old_receipt_import_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE import_jobs SET receipt_outcome_state=NULL
        WHERE user_id=NEW.id AND import_generation<>NEW.import_generation AND receipt_outcome_state IS NOT NULL;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_import_outcomes_generation AFTER UPDATE OF import_generation ON users
      FOR EACH ROW WHEN(OLD.import_generation IS DISTINCT FROM NEW.import_generation)
      EXECUTE FUNCTION clear_old_receipt_import_outcomes()`,
  ],
};
