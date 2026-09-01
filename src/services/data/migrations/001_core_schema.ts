import { Migration } from './Migration';

export const coreSchemaMigration: Migration = {
  version: 1,
  name: 'core_schema',
  statements: [
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receipt_type VARCHAR(50) NOT NULL DEFAULT 'unknown',
      data_source VARCHAR(20) NOT NULL DEFAULT 'csv',
      restaurant_name VARCHAR(255),
      order_date TIMESTAMPTZ,
      amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
      items JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `DO $$
    DECLARE items_type TEXT;
    BEGIN
      SELECT udt_name INTO items_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'receipts'
        AND column_name = 'items';

      IF items_type = '_text' THEN
        ALTER TABLE receipts ALTER COLUMN items TYPE JSONB USING to_jsonb(items);
      ELSIF items_type IS NOT NULL AND items_type <> 'jsonb' THEN
        ALTER TABLE receipts ALTER COLUMN items TYPE JSONB USING items::TEXT::JSONB;
      END IF;
    END $$`,
    'CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_order_date ON receipts(order_date)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_receipt_type ON receipts(receipt_type)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_data_source ON receipts(data_source)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_restaurant_name ON receipts(restaurant_name)',
  ],
};
