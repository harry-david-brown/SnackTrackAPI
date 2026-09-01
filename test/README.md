# Test responsibility map

Tests are grouped by the responsibility named in each file, while `npm test` remains the single entry point.

- Pure domain and calculations: `dashboard-insights.test.js`, `metric-regressions.test.js`, `query-plan-parser.test.js`, `wrapped-analytics-boundaries.test.js`.
- Application operations with fake ports: `auth-capabilities.test.js`, `csv-import-operation.test.js`, `gmail-connection-operation.test.js`, `historical-gmail-import-operation.test.js`, `import-preferences-operation.test.js`, `import-status-operation.test.js`, and `user-summary.test.js`.
- Route contracts: `contract-fixtures.test.js`, `gmail-route-factories.test.js`, `non-auth-route-factories.test.js`, `receipt-list.test.js`, and `error-envelope.test.js`.
- Repository boundary/integration behavior: `import-preferences-repositories.test.js`, `receipt-row-mapper.test.js`, `wrapped-analytics-boundaries.test.js`, and PostgreSQL-backed `account-data-lifecycle-integration.test.js`.
- Migration and resource lifecycle: `database-lifecycle.test.js` plus PostgreSQL-backed `migration-integration.test.js`.
- Lock and concurrency behavior: `account-lifecycle.test.js`, `csv-import-operation.test.js`, and `historical-gmail-import-operation.test.js`.
- Account lifecycle and import state machines: `account-data-lifecycle-integration.test.js`, `account-lifecycle.test.js`, `csv-import-operation.test.js`, `gmail-import-boundaries.test.js`, and `historical-gmail-import-operation.test.js`.

Reusable deterministic clocks, IDs, locks, providers, and caches live in `test/fakes`. Contract examples shared with OpenAPI live in `src/contracts/contractFixtures.ts`; app equivalents live in `SnackTrackApp/__tests__/fixtures`.
