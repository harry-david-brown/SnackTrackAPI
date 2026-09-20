import type { Migration } from './Migration';

/** Source documents survive reversible projection changes; account deletion still cascades. */
export const orderEventsMigration: Migration = {
  version: 27,
  name: 'order_events',
  statements: [
    `ALTER TABLE receipt_observations DROP CONSTRAINT receipt_observations_receipt_id_fkey`,
    `ALTER TABLE receipt_observations ALTER COLUMN receipt_id DROP NOT NULL`,
    `ALTER TABLE receipt_observations ADD COLUMN association_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE receipt_observations ADD COLUMN last_receipt_id UUID`,
    `ALTER TABLE receipt_observations ADD CONSTRAINT receipt_observations_receipt_id_fkey
      FOREIGN KEY(receipt_id) REFERENCES receipts(id) ON DELETE SET NULL`,
    `ALTER TABLE receipt_observations ADD CONSTRAINT receipt_disabled_association_check CHECK(association_enabled OR receipt_id IS NULL)`,
    `CREATE UNIQUE INDEX receipt_owner_identity ON receipts(user_id,id)`,
    `ALTER TABLE receipt_observations ADD CONSTRAINT receipt_observation_owner_check
      FOREIGN KEY(user_id,receipt_id) REFERENCES receipts(user_id,id) DEFERRABLE INITIALLY DEFERRED`,
    `CREATE UNIQUE INDEX receipt_observation_owner_membership ON receipt_observations(user_id,receipt_id,id)`,
    `CREATE FUNCTION preserve_receipt_observation_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR
           NEW.document_key IS DISTINCT FROM OLD.document_key OR NEW.parser_version IS DISTINCT FROM OLD.parser_version OR
           NEW.import_generation IS DISTINCT FROM OLD.import_generation OR NEW.payload IS DISTINCT FROM OLD.payload OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.batch_id IS NOT NULL AND NEW.batch_id IS DISTINCT FROM OLD.batch_id)
        THEN RAISE EXCEPTION 'Receipt source observations are immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_observation_source_immutable BEFORE UPDATE ON receipt_observations
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_observation_source()`,
    `ALTER TABLE receipts
      ADD COLUMN order_fulfillment TEXT GENERATED ALWAYS AS (resolution->'orderOutcome'->>'fulfillment') STORED,
      ADD COLUMN order_kind TEXT GENERATED ALWAYS AS (resolution->'orderOutcome'->>'kind') STORED,
      ADD COLUMN order_refund_status TEXT GENERATED ALWAYS AS (resolution->'orderOutcome'->>'refundStatus') STORED,
      ADD COLUMN order_net_amount NUMERIC(14,2) GENERATED ALWAYS AS
        (CASE WHEN jsonb_typeof(resolution->'orderOutcome'->'netAmount')='number'
         THEN (resolution->'orderOutcome'->>'netAmount')::numeric ELSE NULL END) STORED`,
    `ALTER TABLE receipts
      ADD CONSTRAINT receipt_order_fulfillment_check CHECK(order_fulfillment IS NULL OR order_fulfillment IN ('completed','canceled','failed','unfulfilled','unknown')),
      ADD CONSTRAINT receipt_order_kind_check CHECK(order_kind IS NULL OR order_kind IN ('order','unlinked_adjustment')),
      ADD CONSTRAINT receipt_order_refund_status_check CHECK(order_refund_status IS NULL OR order_refund_status IN ('none_established','partial','full','reversed','probable_full','zero_unexplained','conflicted')),
      ADD CONSTRAINT receipt_order_net_amount_check CHECK(order_net_amount IS NULL OR order_net_amount>=0)`,
    `CREATE INDEX receipt_user_fulfillment_date ON receipts(user_id,order_fulfillment,order_date)`,
    `CREATE INDEX receipt_user_refund_date ON receipts(user_id,order_refund_status,order_date)`,
    `CREATE TABLE receipt_order_events (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receipt_id UUID NOT NULL, event_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('charge','refund','charge_adjustment','refund_reversal')),
      amount NUMERIC(14,2) NOT NULL CHECK(amount>=0), currency_code TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK(confidence IN ('confirmed','inferred','unknown','conflicted')),
      occurred_at TIMESTAMPTZ, reported_at TIMESTAMPTZ, payload JSONB NOT NULL,
      PRIMARY KEY(user_id,receipt_id,event_key),
      FOREIGN KEY(user_id,receipt_id) REFERENCES receipts(user_id,id) ON DELETE CASCADE)`,
    `CREATE TABLE receipt_order_event_observations (
      user_id UUID NOT NULL, receipt_id UUID NOT NULL, event_key TEXT NOT NULL, observation_id UUID NOT NULL,
      PRIMARY KEY(user_id,receipt_id,event_key,observation_id),
      FOREIGN KEY(user_id,receipt_id,event_key) REFERENCES receipt_order_events(user_id,receipt_id,event_key) ON DELETE CASCADE,
      FOREIGN KEY(user_id,receipt_id,observation_id) REFERENCES receipt_observations(user_id,receipt_id,id)
        DEFERRABLE INITIALLY DEFERRED)`,
    `CREATE INDEX receipt_order_events_user_kind_time ON receipt_order_events(user_id,kind,occurred_at)`,
    `ALTER TABLE receipt_import_batches ADD COLUMN association_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN successful_completion BOOLEAN NOT NULL DEFAULT TRUE`,
    `CREATE FUNCTION preserve_receipt_import_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (to_jsonb(NEW)-'association_enabled') IS DISTINCT FROM (to_jsonb(OLD)-'association_enabled')
        THEN RAISE EXCEPTION 'Import batch provenance is immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_import_batch_immutable BEFORE UPDATE ON receipt_import_batches
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_import_batch()`,
    `ALTER TABLE receipt_reconciliation_lineage ALTER COLUMN new_receipt_id DROP NOT NULL,
      ADD COLUMN observation_ids UUID[] NOT NULL DEFAULT '{}'`,
    `CREATE TABLE receipt_repair_source_batches (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      import_generation INTEGER NOT NULL, parser_version INTEGER NOT NULL,
      fingerprint CHAR(64) NOT NULL, provenance JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
      UNIQUE(user_id,id), UNIQUE(user_id,import_generation,fingerprint))`,
    `CREATE TABLE receipt_repair_source_observations (
      id UUID PRIMARY KEY, user_id UUID NOT NULL, batch_id UUID NOT NULL,
      document_key CHAR(64) NOT NULL, payload JSONB NOT NULL,
      FOREIGN KEY(user_id,batch_id) REFERENCES receipt_repair_source_batches(user_id,id) ON DELETE CASCADE,
      UNIQUE(user_id,batch_id,document_key))`,
    `CREATE FUNCTION preserve_receipt_repair_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Staged repair sources are immutable'; END $$`,
    `CREATE TRIGGER receipt_repair_source_immutable BEFORE UPDATE ON receipt_repair_source_observations
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_repair_source()`,
    `CREATE TRIGGER receipt_repair_batch_immutable BEFORE UPDATE ON receipt_repair_source_batches
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_repair_source()`,
    `ALTER TABLE receipt_repair_manifests
      ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 2,
      ADD COLUMN staged_batch_ids UUID[] NOT NULL DEFAULT '{}',
      ADD COLUMN staged_fingerprint TEXT,
      ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days'`,
    `CREATE FUNCTION preserve_receipt_repair_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR
           NEW.import_generation IS DISTINCT FROM OLD.import_generation OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
           NEW.parser_version IS DISTINCT FROM OLD.parser_version OR NEW.before_fingerprint IS DISTINCT FROM OLD.before_fingerprint OR
           NEW.before_state IS DISTINCT FROM OLD.before_state OR NEW.after_state IS DISTINCT FROM OLD.after_state OR
           NEW.staged_batch_ids IS DISTINCT FROM OLD.staged_batch_ids OR NEW.staged_fingerprint IS DISTINCT FROM OLD.staged_fingerprint OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        THEN RAISE EXCEPTION 'Prepared repair inputs are immutable'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER receipt_repair_manifest_immutable BEFORE UPDATE ON receipt_repair_manifests
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_repair_manifest()`,
    `CREATE TABLE receipt_association_reviews (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      import_generation INTEGER NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('merge','keep_separate','revoke')),
      observation_ids UUID[] NOT NULL, supersedes_id UUID,
      reason TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,id), FOREIGN KEY(user_id,supersedes_id) REFERENCES receipt_association_reviews(user_id,id),
      CHECK((decision='revoke' AND supersedes_id IS NOT NULL) OR (decision<>'revoke' AND cardinality(observation_ids)>=2)))`,
    `CREATE INDEX receipt_association_reviews_user_time ON receipt_association_reviews(user_id,created_at)`,
    `CREATE TRIGGER receipt_association_review_immutable BEFORE UPDATE ON receipt_association_reviews
      FOR EACH ROW EXECUTE FUNCTION preserve_receipt_repair_source()`,
  ],
};
