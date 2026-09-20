import type { Migration } from './Migration';
export const receiptReconciliationMigration: Migration = {
  version:26, name:'receipt_reconciliation', statements:[
    `CREATE TABLE receipt_import_batches (
      id TEXT NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, observed_start TIMESTAMPTZ NOT NULL, observed_end TIMESTAMPTZ NOT NULL,
      declared_start TIMESTAMPTZ, declared_end TIMESTAMPTZ,
      accepted_orders INTEGER NOT NULL, rejected_records INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,id),
      CHECK(observed_start<=observed_end), CHECK(accepted_orders>0 AND rejected_records>=0),
      CHECK((declared_start IS NULL AND declared_end IS NULL) OR (declared_start IS NOT NULL AND declared_end IS NOT NULL AND declared_start<=declared_end)))`,
    `ALTER TABLE receipt_observations ADD COLUMN batch_id TEXT`,
    `CREATE TABLE receipt_reconciliation_lineage (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      old_receipt_id UUID NOT NULL, new_receipt_id UUID NOT NULL, policy_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE INDEX receipt_lineage_user_old ON receipt_reconciliation_lineage(user_id,old_receipt_id)`,
    `CREATE TABLE receipt_repair_manifests (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      import_generation INTEGER NOT NULL, policy_version INTEGER NOT NULL,
      before_fingerprint TEXT NOT NULL, after_fingerprint TEXT,
      before_state JSONB NOT NULL, after_state JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','published','rolled_back')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ, rolled_back_at TIMESTAMPTZ)`,
    `CREATE INDEX receipt_repair_user_created ON receipt_repair_manifests(user_id,created_at DESC)`,
  ],
};
