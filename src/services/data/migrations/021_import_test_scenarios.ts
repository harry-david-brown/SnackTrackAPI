import { Migration } from './Migration';

export const importTestScenariosMigration: Migration = {
  version: 21,
  name: 'import_test_scenarios',
  statements: [
    `CREATE TABLE IF NOT EXISTS user_import_test_scenarios (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scenario VARCHAR(64) NOT NULL CHECK (scenario IN ('gmail_long_running')),
      enabled BOOLEAN NOT NULL DEFAULT false,
      reason VARCHAR(500),
      updated_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id,scenario)
    )`,
    `CREATE TABLE IF NOT EXISTS import_test_scenario_runs (
      job_id UUID PRIMARY KEY REFERENCES import_jobs(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scenario VARCHAR(64) NOT NULL CHECK (scenario IN ('gmail_long_running')),
      resume_at TIMESTAMPTZ NOT NULL,
      resumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_import_test_scenario_runs_user ON import_test_scenario_runs(user_id,created_at DESC)',
  ],
};
