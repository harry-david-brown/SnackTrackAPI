import { Migration } from './Migration';

export const launchAdsMigration: Migration = {
  version: 17,
  name: 'launch_ads',
  statements: [
    `CREATE TABLE IF NOT EXISTS ad_runtime_config (
      config_key VARCHAR(40) PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ios_rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (ios_rollout_percent BETWEEN 0 AND 100),
      android_rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (android_rollout_percent BETWEEN 0 AND 100),
      placement VARCHAR(40) NOT NULL DEFAULT 'dashboard_after_insights'
        CHECK (placement IN ('dashboard_after_insights', 'dashboard_footer')),
      max_impressions_per_session INTEGER NOT NULL DEFAULT 1
        CHECK (max_impressions_per_session BETWEEN 1 AND 3),
      minimum_receipt_count INTEGER NOT NULL DEFAULT 3
        CHECK (minimum_receipt_count BETWEEN 1 AND 100),
      version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL
    )`,
    `INSERT INTO ad_runtime_config
      (config_key, enabled, ios_rollout_percent, android_rollout_percent, placement,
       max_impressions_per_session, minimum_receipt_count)
     VALUES ('launch_ads', FALSE, 0, 0, 'dashboard_after_insights', 1, 3)
     ON CONFLICT (config_key) DO NOTHING`,
  ],
};
