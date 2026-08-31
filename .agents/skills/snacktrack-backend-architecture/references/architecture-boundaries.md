# Architecture boundaries

Use this reference when choosing ownership, extracting a module, adding a dependency, or reviewing architectural cleanliness.

## Responsibilities

### Transport: routes and middleware

Routes should:

- obtain authenticated identity from trusted middleware;
- validate and normalize path, query, body, and upload metadata;
- invoke a cohesive application operation;
- map known results/errors to the documented HTTP contract; and
- send exactly one response.

Routes should not contain SQL, cache-key policy, provider workflows, multi-step business decisions, or duplicated authorization rules. Middleware should implement cross-cutting transport behavior, not feature-specific domain policy.

### Application services and use cases

An application service owns a user-meaningful operation such as importing receipts, resetting account data, or producing a dashboard summary. It coordinates domain logic and ports, defines sequencing and postconditions, and returns a transport-neutral result.

Prefer methods named for intent (`resetAccountData`, `importGmailReceipts`) over technical sequences (`deleteRowsAndClearCache`). Split a service when it owns unrelated reasons to change, not merely because its file is long.

### Domain logic

Calculations, matching, classification, normalization, eligibility, and selection should be pure where possible. Pure modules accept internal values and return internal values without importing Express, PostgreSQL, Redis, logging, configuration, or provider SDKs.

Keep policy close to the domain noun it governs. Do not move meaningful rules into a generic `utils` file merely because they are functions.

### Repositories and infrastructure adapters

Repositories express persistence operations in domain language and isolate SQL/row mapping. Provider adapters isolate Gmail, OAuth, email, cache, filesystem, and other vendor details.

- Parameterize SQL and map database rows deliberately.
- Do not return raw `QueryResult`, database clients, or vendor SDK objects to routes.
- Keep transaction ownership visible to the application operation; do not silently open independent transactions inside steps that must be atomic together.
- Convert provider payloads and errors at the adapter boundary.

For transaction, migration, cache, or concurrency design, also use `snacktrack-backend-engineering`.

## Dependency direction

Allowed direction:

1. routes/middleware depend on application services and transport schemas;
2. application services depend on domain logic and narrow ports;
3. infrastructure adapters implement ports and depend on SDK/database libraries;
4. the composition root depends on every concrete implementation and wires them together.

Avoid:

- domain or repository modules importing routes;
- services receiving `Request` or `Response`;
- leaf modules importing the global container;
- circular imports resolved through barrels;
- shared helpers that import feature modules; and
- configuration or provider SDK access scattered through business logic.

## Composition and dependency injection

`src/services/core/ServiceContainer.ts` is the current composition root. New dependencies should be explicit and typed.

- Prefer constructor injection for stateful services and parameter injection for small pure operations.
- Depend on the narrow capability needed, not an oversized service.
- Create interfaces/types at volatile or test-substitutable boundaries: persistence, clock, ID generation, cache, provider, mail, and external filesystem/network access.
- Do not create an interface that has one implementation and no boundary value solely to satisfy a pattern.
- Do not add new string keys or `Map<string, any>` lookups. Move touched registrations toward typed properties/factories without requiring an all-at-once container rewrite.
- Construct long-lived clients once when their lifecycle is application-wide; clean them up through the application shutdown path.

## Module cohesion

A module is cohesive when its exports share one domain responsibility and change for the same product reason.

Signs ownership is wrong:

- a route and service both decide the same state transition;
- a repository decides HTTP status or user-facing recovery;
- one service knows unrelated Gmail, analytics, authentication, and receipt details;
- a `utils` module contains business-specific policies from several domains;
- callers must invoke methods in an undocumented order; or
- changing one response field requires edits across many unrelated modules.

Prefer a small public surface. Export the operation and types callers need; keep parsing steps and implementation details private to the module. Avoid broad barrel files when they hide cycles or unintentionally make internals public.

## Cross-cutting behavior

Authentication, authorization, validation, rate limiting, request correlation, error serialization, and request logging belong in consistent transport infrastructure. Business services must still enforce domain ownership where identity is part of the invariant; middleware alone is not a substitute for a user-scoped query or mutation.
