# Database migration operations

SnackTrackAPI owns schema evolution through the ordered registry in
`src/services/data/migrations`. `PostgresService` owns only pool, query,
transaction, and close behavior; it must not contain schema mutations.

## Applying migrations

Run migrations as a release step before shifting traffic to a new API build:

```sh
npm run migrate
```

The command uses `DATABASE_URL` and the validated database SSL configuration.
The API also runs the same migration runner before Redis, monitoring jobs, or
the HTTP listener starts. This startup check is a safety net, not a substitute
for the release step when deployments can run migrations separately.

The runner:

- takes a PostgreSQL advisory lock so concurrent deploys serialize;
- creates `schema_migrations` if needed;
- verifies the name and SHA-256 checksum of every applied version;
- applies each pending version in its own transaction;
- records a version only after all of its statements succeed;
- rolls back and refuses startup when a migration fails;
- refuses startup when the database contains an unknown newer version or an
  applied migration file was edited.

Applied migration files are immutable. Correct a released migration with a new
higher-numbered file; never change an applied statement or checksum.

Migration 003 expands and backfills provider-specific export lifecycle rows.
Migration 005 is its contract step: it removes the obsolete aggregate export
status columns only after all API projections and commands use
`user_export_provider_preferences` as the sole lifecycle authority.

## Expand, backfill, contract

Use separate ordered migrations for changes that cannot be safely completed in
one short transaction:

1. **Expand:** add nullable columns, additive tables, indexes, or permissive
   constraints while old and new application versions can both run.
2. **Backfill:** update existing rows in bounded batches. Make the operation
   restartable and observable; avoid holding one transaction across the full
   data set.
3. **Contract:** after all callers use the new representation and the backfill
   is verified, add `NOT NULL`/strict constraints or remove obsolete fields in
   a later release.

Large production indexes should use a deliberately non-transactional migration
strategy with `CREATE INDEX CONCURRENTLY`; the current runner intentionally
rejects silently mixing that behavior into its transactional migrations. Add
explicit runner support and tests before introducing such a migration.

## Rollback policy

Application rollback is safe only while the previous build understands the
expanded schema. Schema versions are not deleted automatically and migrations
do not define destructive `down` operations.

For a failed migration, PostgreSQL rolls back that version and leaves it
unrecorded. Fix the unapplied migration before release. For a migration that
was already applied in production, prefer a forward corrective migration. If
data restoration is unavoidable, stop writes, take or verify a backup, restore
through the database provider's recovery process, and then reconcile
`schema_migrations`. Never manually delete a recorded version while API
instances are running.

Before release, review potential uniqueness violations, invalid enum values,
and backfill volume. The receipt-identity migration deliberately fails rather
than silently discard unexpected duplicate external identifiers.

## Verification

The default test suite exercises migration ordering, locking, checksum drift,
rollback, transaction scope, health policy, and idempotent shutdown. Real DDL
coverage uses isolated schemas and requires a disposable test database:

```sh
MIGRATION_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/snacktrack_test npm test
```

The integration tests build an empty schema and upgrade a representative legacy
schema, verify retained data and converted types, then drop both temporary
schemas. CI supplies this variable for its PostgreSQL service.
