import { Migration } from './Migration';

export const receiptIdentityAndAnalyticsMigration: Migration = {
  version: 4,
  name: 'receipt_identity_and_analytics',
  statements: [
    `ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS delivery_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS external_id TEXT,
      ADD COLUMN IF NOT EXISTS source_identity TEXT,
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS year INTEGER`,
    `DO $$
    DECLARE
      order_date_needs_conversion BOOLEAN;
      delivery_time_needs_conversion BOOLEAN;
      year_trigger_existed BOOLEAN;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'receipts'
          AND column_name = 'order_date' AND data_type = 'timestamp without time zone'
      ) INTO order_date_needs_conversion;
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'receipts'
          AND column_name = 'delivery_time' AND data_type = 'timestamp without time zone'
      ) INTO delivery_time_needs_conversion;

      IF order_date_needs_conversion THEN
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'receipts'::regclass
            AND tgname = 'trigger_update_receipt_year'
            AND NOT tgisinternal
        ) INTO year_trigger_existed;
        IF year_trigger_existed THEN DROP TRIGGER trigger_update_receipt_year ON receipts; END IF;
        ALTER TABLE receipts ALTER COLUMN order_date TYPE TIMESTAMPTZ
          USING order_date AT TIME ZONE 'UTC';
      END IF;

      IF delivery_time_needs_conversion THEN
        ALTER TABLE receipts ALTER COLUMN delivery_time TYPE TIMESTAMPTZ
          USING delivery_time AT TIME ZONE 'UTC';
      END IF;
    END $$`,
    `UPDATE receipts
      SET first_seen_at = created_at AT TIME ZONE 'UTC'
      WHERE created_at IS NOT NULL
        AND first_seen_at > (created_at AT TIME ZONE 'UTC') + INTERVAL '1 minute'`,
    `UPDATE receipts
      SET source_identity = CASE
        WHEN external_id IS NOT NULL THEN 'external:' || external_id
        WHEN order_date IS NOT NULL THEN
          'fallback:' || LOWER(BTRIM(COALESCE(restaurant_name, 'unknown'))) || '|' ||
          TO_CHAR(order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
        ELSE NULL
      END
      WHERE data_source = 'email' AND source_identity IS NULL`,
    `DELETE FROM receipts duplicate
      USING receipts keeper
      WHERE duplicate.user_id = keeper.user_id
        AND duplicate.data_source = 'email'
        AND keeper.data_source = 'email'
        AND duplicate.source_identity = keeper.source_identity
        AND duplicate.source_identity IS NOT NULL
        AND (
          duplicate.amount_spent < keeper.amount_spent
          OR (duplicate.amount_spent = keeper.amount_spent AND duplicate.id::TEXT > keeper.id::TEXT)
        )`,
    `UPDATE receipts SET year = EXTRACT(YEAR FROM order_date)::INTEGER
      WHERE year IS NULL AND order_date IS NOT NULL`,
    `CREATE OR REPLACE FUNCTION update_receipt_year()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.year := CASE WHEN NEW.order_date IS NULL
          THEN NULL ELSE EXTRACT(YEAR FROM NEW.order_date)::INTEGER END;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trigger_update_receipt_year ON receipts`,
    `CREATE TRIGGER trigger_update_receipt_year
      BEFORE INSERT OR UPDATE OF order_date ON receipts
      FOR EACH ROW EXECUTE FUNCTION update_receipt_year()`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_source_identity_unique
      ON receipts(user_id, data_source, source_identity)
      WHERE source_identity IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_external_id_unique
      ON receipts(user_id, external_id) WHERE external_id IS NOT NULL`,
    'CREATE INDEX IF NOT EXISTS idx_receipts_external_id ON receipts(external_id)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_year ON receipts(year, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_items_gin ON receipts USING GIN (items)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_user_date_composite ON receipts(user_id, order_date DESC)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_order_date_user ON receipts(order_date, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_restaurant_user ON receipts(restaurant_name, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_amount_user ON receipts(amount_spent DESC, user_id)',
  ],
};
