import { Migration } from './Migration';

export const adminAnalyticsMigration: Migration = {
  version: 9,
  name: 'admin_analytics',
  statements: [
    `CREATE TABLE IF NOT EXISTS analytics_events (
      event_id UUID PRIMARY KEY,
      event_name VARCHAR(80) NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
      occurred_at TIMESTAMPTZ NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      source VARCHAR(20) NOT NULL CHECK (source IN ('mobile', 'server', 'backfill')),
      platform VARCHAR(20) CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web', 'server')),
      app_version VARCHAR(40),
      provider VARCHAR(24),
      session_id VARCHAR(120),
      properties JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
      metric_date DATE NOT NULL,
      metric_name VARCHAR(80) NOT NULL,
      dimensions JSONB NOT NULL DEFAULT '{}'::JSONB,
      metric_value NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (metric_date, metric_name, dimensions)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_analytics_events_name_occurred ON analytics_events(event_name, occurred_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_events_user_occurred ON analytics_events(user_id, occurred_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_events_occurred ON analytics_events(occurred_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_rollups_name_date ON analytics_daily_rollups(metric_name, metric_date DESC)',
  ],
};
