import { Migration } from './Migration';

export const adPlacementsV2Migration: Migration = {
  version: 19,
  name: 'ad_placements_v2',
  statements: [
    `ALTER TABLE ad_runtime_config
      ADD COLUMN IF NOT EXISTS placements JSONB NOT NULL
        DEFAULT '["dashboard_after_insights", "history_after_fifth_order"]'::jsonb,
      ADD COLUMN IF NOT EXISTS max_impressions_per_day INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE ad_runtime_config
      DROP CONSTRAINT IF EXISTS ad_runtime_config_max_impressions_per_day_check`,
    `ALTER TABLE ad_runtime_config
      ADD CONSTRAINT ad_runtime_config_max_impressions_per_day_check
      CHECK (max_impressions_per_day BETWEEN 1 AND 10)`,
  ],
};
