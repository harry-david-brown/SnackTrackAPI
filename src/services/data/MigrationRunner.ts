import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseError } from '../../core/errors';
import { logger } from '../../config/logger';
import { Migration } from './migrations/Migration';

interface MigrationClientProvider {
  getClient(): Promise<PoolClient>;
}

interface AppliedMigrationRow extends QueryResultRow {
  version: unknown;
  name: unknown;
  checksum: unknown;
}

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationRunResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
}

const MIGRATION_LOCK_KEY = 746162852;

export const migrationChecksum = (migration: Migration): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: migration.version,
        name: migration.name,
        statements: migration.statements,
      }),
    )
    .digest('hex');

const validateRegistry = (migrations: readonly Migration[]): void => {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new DatabaseError('Migration versions must be positive and strictly increasing');
    }
    if (!/^[a-z0-9_]+$/.test(migration.name) || names.has(migration.name)) {
      throw new DatabaseError(`Invalid or duplicate migration name: ${migration.name}`);
    }
    if (migration.statements.length === 0 || migration.statements.some((sql) => !sql.trim())) {
      throw new DatabaseError(`Migration ${migration.version} contains no executable statements`);
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
};

const appliedMigration = (row: AppliedMigrationRow): AppliedMigration => {
  const version = typeof row.version === 'number' ? row.version : Number(row.version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new DatabaseError('Migration history contains an invalid version');
  }
  if (typeof row.name !== 'string' || !row.name) {
    throw new DatabaseError(`Migration history ${version} contains an invalid name`);
  }
  if (typeof row.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(row.checksum)) {
    throw new DatabaseError(`Migration history ${version} contains an invalid checksum`);
  }
  return { version, name: row.name, checksum: row.checksum };
};

/** Runs ordered schema migrations under a process-independent PostgreSQL advisory lock. */
export class MigrationRunner {
  constructor(
    private readonly clients: MigrationClientProvider,
    private readonly migrations: readonly Migration[],
  ) {
    validateRegistry(migrations);
  }

  async run(): Promise<MigrationRunResult> {
    const client = await this.clients.getClient();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      locked = true;
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const historyResult = await client.query<AppliedMigrationRow>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const history = historyResult.rows.map(appliedMigration);
      const byVersion = new Map(this.migrations.map((migration) => [migration.version, migration]));

      for (const applied of history) {
        const migration = byVersion.get(applied.version);
        if (!migration) {
          throw new DatabaseError(
            `Database migration ${applied.version} is newer than or missing from this application build`,
          );
        }
        if (applied.name !== migration.name || applied.checksum !== migrationChecksum(migration)) {
          throw new DatabaseError(
            `Applied migration ${applied.version} does not match the immutable migration registry`,
          );
        }
      }

      const appliedVersions = new Set(history.map(({ version }) => version));
      const newlyApplied: number[] = [];
      for (const migration of this.migrations) {
        if (appliedVersions.has(migration.version)) continue;
        await this.apply(client, migration);
        newlyApplied.push(migration.version);
      }
      return {
        applied: newlyApplied,
        alreadyApplied: history.map(({ version }) => version),
      };
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
        } catch (error) {
          logger.error('Failed to release PostgreSQL migration lock', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      client.release();
    }
  }

  private async apply(client: PoolClient, migration: Migration): Promise<void> {
    try {
      await client.query('BEGIN');
      for (const statement of migration.statements) await client.query(statement);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migrationChecksum(migration)],
      );
      await client.query('COMMIT');
      logger.info('Database migration applied', {
        version: migration.version,
        name: migration.name,
      });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Database migration rollback failed', {
          version: migration.version,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw new DatabaseError(`Migration ${migration.version} (${migration.name}) failed`, error);
    }
  }
}
