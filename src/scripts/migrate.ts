import 'dotenv/config';
import { config } from '../config/AppConfig';
import { logger } from '../config/logger';
import { MigrationRunner } from '../services/data/MigrationRunner';
import { migrations } from '../services/data/migrations';
import { PostgresService } from '../services/data/PostgresService';

const postgres = new PostgresService({
  connectionString: config.getDatabaseConnectionString(),
  useSsl: config.shouldUseDatabaseSSL(),
  sslCa: config.getDatabaseSslCa(),
  maxConnections: 2,
  minimumConnections: 0,
});

const run = async (): Promise<void> => {
  try {
    const result = await new MigrationRunner(postgres, migrations).run();
    logger.info('Database migration command completed', {
      appliedVersions: result.applied,
      existingVersions: result.alreadyApplied,
    });
  } catch (error) {
    logger.error('Database migration command failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await postgres.close();
  }
};

void run();
