# Contributing to SnackTrackAPI

Read `AGENTS.md`, the architecture decisions in `docs/architecture`, and the applicable lifecycle or
contract catalog before changing a feature.

## Feature and change checklist

1. Define the public request, response DTO, stable error codes, authorization policy, and committed
   postconditions.
2. Decode route, provider, file, cache, and database input once at its adapter boundary.
3. Add a cohesive application operation with narrow ports. Keep workflow ordering outside Express.
4. Put SQL and row mapping in a repository. Use `DatabaseTransactionRunner` for atomic work and a
   passed transaction executor where several repositories participate.
5. For any receipt mutation, acquire the shared user writer lock and assert ownership before batches
   and commit.
6. Classify provider calls, cache invalidation, and other effects using ADR 006. Run post-commit effects
   only after durable success and define retry/idempotency behavior.
7. Wire concrete adapters once in `ServiceContainer` and inject them through a route factory.
8. Update OpenAPI, `docs/API_CONTRACT_CATALOG.md`, frontend normalizers/contracts, query ownership, and
   cache invalidation together when a public contract changes.
9. Add focused pure-policy, use-case fake-port, route-contract, repository/migration, concurrency, and
   cross-stack tests appropriate to the risk. Cover expected and unexpected failures plus cleanup.
10. Remove the superseded path, run build/test/lint/format/architecture gates, and inspect the final
    diff for raw SQL, container reach-through, unsafe input, stale cache, and swallowed errors.

## Representative vertical slice: receipt listing

`createReceiptsRouter` authenticates, decodes query fields, derives token identity, and invokes
`ListReceiptsService`. The service accepts `ReceiptListFilters` and delegates to `ReceiptRepository`.
The repository builds one predicate shared by list and count, decodes `ReceiptRow` into the domain
`Receipt`, and returns a page. `receiptResponse` maps domain records into the public DTO. The frontend
`receiptApi` validates that DTO, while `useReceiptsQuery` owns parameterized server cache state.

Follow the same path for new slices:

`route factory → application operation → domain/ports → repository/provider adapter → transport mapper`

Do not skip layers merely because an endpoint is small; keep each layer narrow enough that the extra
boundary adds clarity and testability rather than ceremony.
