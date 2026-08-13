# Diagnostics and testing

## Safe diagnosis

- Start with logs, source, and schema; use database reads only when needed.
- Resolve the active database without printing connection strings or secrets.
- Use read-only, user-scoped aggregate queries.
- Compare operation timestamps across lifecycle rows, audit rows, sync runs, and inserted domain rows.
- Clearly distinguish evidence from inference.

## Error contract

Define:

1. HTTP status and stable error code;
2. committed/rolled-back state;
3. credential and consent effects;
4. retryability;
5. cache behavior;
6. user recovery action.

## Test layers

- Repository/service: transaction ordering, SQL postconditions, rollback, client release, lock release.
- Concurrency: writer/reset sequencing, timeout, ownership safety.
- Route: authentication/ownership, response body, cache invalidation.
- Migration: fresh and existing schema behavior.
- Integration: recompute summaries from durable rows after mutation.

Run from `SnackTrackAPI/`:

```sh
npm run build
npm test
```

Inspect `git diff --check` and avoid claiming live-state correctness unless the relevant database was safely verified.
