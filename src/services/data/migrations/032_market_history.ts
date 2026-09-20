import type { Migration } from './Migration';
export const marketHistoryMigration: Migration = {
  version: 32,
  name: 'market_history',
  statements: [
    `CREATE TABLE market_history_snapshots (
      id UUID PRIMARY KEY, valuation_date DATE NOT NULL UNIQUE, retrieved_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'))`,
    `CREATE TABLE market_history_refresh_lease (id INTEGER PRIMARY KEY CHECK(id=1), token UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`,
  ],
};
