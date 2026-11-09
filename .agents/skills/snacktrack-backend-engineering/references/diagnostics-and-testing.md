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

For ordinary code changes, run the API TypeScript and lint checks:

```sh
npm run build
npm run lint
```

Run one final verification pass after implementation is complete: the relevant TypeScript check and lint coverage for changed/staged code and tests. Do not run routine checks between edits or repeatedly during implementation. Avoid duplicate lint runs when the repository-wide check already covers those files. If a final check fails, fix the issue and re-run only the affected check; once checks pass, stop unless subsequent code changes invalidate the result. Fix changed-file errors and warnings without suppressing rules or bypassing commit hooks; report unrelated pre-existing failures explicitly. Lint changed/staged tests with the local ESLint binary and `--max-warnings=0` as the API lint script covers only `src`.

Do not run focused tests, `npm test`, or other test suites unless the user explicitly requests them. Adding regression coverage does not imply running it.

Inspect `git diff --check` and avoid claiming live-state correctness unless the relevant database was safely verified.
