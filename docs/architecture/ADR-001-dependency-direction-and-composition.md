# ADR 001: Dependency direction and composition

**Status:** Accepted

Routes and middleware are transport adapters. They authenticate, authorize, decode input, invoke one
application capability, and map its result. Application services own workflow ordering and depend on
small domain, repository, cache, lock, and provider ports. Data stores and provider SDKs remain in
adapters.

`ServiceContainer` is the typed process composition root. `src/index.ts` supplies its capabilities to
router and middleware factories. Production modules must not resolve string keys, create process-wide
resources, or import the container. The architecture check enforces the most important dependency
rules and rejects static cycles.

This direction makes application behavior testable with fakes and prevents Express, PostgreSQL,
Redis, or provider SDK types from leaking into domain policy.
