import type { Migration } from './Migration';
export const automaticUpdatesOfferMigration: Migration = {
  version: 36, name: 'automatic_updates_offer',
  statements: ['ALTER TABLE user_import_preferences ADD COLUMN automatic_updates_offer_seen_at TIMESTAMPTZ'],
};
