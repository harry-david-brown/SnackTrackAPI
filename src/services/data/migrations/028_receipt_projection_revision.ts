import type { Migration } from './Migration';

/** A committed revision namespaces projections independently of best-effort Redis deletion.
 * Transaction IDs are opaque equality tokens, not a commit-order counter. Multiple receipt
 * statements in one transaction share a revision; rollback also rolls back the revision.
 */
export const receiptProjectionRevisionMigration: Migration = {
  version: 28,
  name: 'receipt_projection_revision',
  statements: [
    `ALTER TABLE users ADD COLUMN receipt_projection_revision BIGINT NOT NULL DEFAULT 0
      CHECK(receipt_projection_revision>=0)`,
    `CREATE FUNCTION revise_inserted_receipt_projections() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE users SET receipt_projection_revision=txid_current()
          WHERE id IN (SELECT DISTINCT user_id FROM inserted_receipts)
          AND receipt_projection_revision IS DISTINCT FROM txid_current();
        RETURN NULL;
      END $$`,
    `CREATE FUNCTION revise_updated_receipt_projections() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE users SET receipt_projection_revision=txid_current()
          WHERE id IN (SELECT user_id FROM previous_receipts UNION SELECT user_id FROM updated_receipts)
          AND receipt_projection_revision IS DISTINCT FROM txid_current();
        RETURN NULL;
      END $$`,
    `CREATE FUNCTION revise_deleted_receipt_projections() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE users SET receipt_projection_revision=txid_current()
          WHERE id IN (SELECT DISTINCT user_id FROM deleted_receipts)
          AND receipt_projection_revision IS DISTINCT FROM txid_current();
        RETURN NULL;
      END $$`,
    `CREATE FUNCTION revise_truncated_receipt_projections() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE users SET receipt_projection_revision=txid_current()
          WHERE receipt_projection_revision IS DISTINCT FROM txid_current();
        RETURN NULL;
      END $$`,
    `CREATE TRIGGER receipt_projection_insert AFTER INSERT ON receipts
      REFERENCING NEW TABLE AS inserted_receipts FOR EACH STATEMENT
      EXECUTE FUNCTION revise_inserted_receipt_projections()`,
    `CREATE TRIGGER receipt_projection_update AFTER UPDATE ON receipts
      REFERENCING OLD TABLE AS previous_receipts NEW TABLE AS updated_receipts FOR EACH STATEMENT
      EXECUTE FUNCTION revise_updated_receipt_projections()`,
    `CREATE TRIGGER receipt_projection_delete AFTER DELETE ON receipts
      REFERENCING OLD TABLE AS deleted_receipts FOR EACH STATEMENT
      EXECUTE FUNCTION revise_deleted_receipt_projections()`,
    `CREATE TRIGGER receipt_projection_truncate AFTER TRUNCATE ON receipts
      FOR EACH STATEMENT EXECUTE FUNCTION revise_truncated_receipt_projections()`,
    `CREATE FUNCTION revise_receipt_projection_profile() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email IS DISTINCT FROM OLD.email OR NEW.timezone IS DISTINCT FROM OLD.timezone
          OR NEW.import_generation IS DISTINCT FROM OLD.import_generation THEN
          NEW.receipt_projection_revision := txid_current();
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_projection_profile BEFORE UPDATE OF email,timezone,import_generation ON users
      FOR EACH ROW EXECUTE FUNCTION revise_receipt_projection_profile()`,
  ],
};
