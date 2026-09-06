import { Migration } from './Migration';

export const importJourneyContextMigration: Migration = {
  version: 20,
  name: 'import_journey_context',
  statements: [
    `ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS journey_context VARCHAR(24) NOT NULL DEFAULT 'legacy'`,
    `DO $$ BEGIN
      ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_journey_context_check
        CHECK (journey_context IN ('onboarding','post_onboarding','routine','legacy'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`,
  ],
};
