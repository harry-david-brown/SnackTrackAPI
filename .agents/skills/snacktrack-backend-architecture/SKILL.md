---
name: snacktrack-backend-architecture
description: Design, implement, review, and incrementally refactor SnackTrackAPI TypeScript code with clean module boundaries, dependency direction, domain-oriented services, typed contracts, testable dependencies, and consistent errors and observability. Use for every API feature, bug fix, code review, architecture decision, service extraction, or cleanup. Also load snacktrack-backend-engineering when work involves persistence, transactions, migrations, caches, locks, background jobs, or live-data diagnosis.
---

# SnackTrack Backend Architecture

Keep `SnackTrackAPI` understandable as it grows: one owner per responsibility, dependencies that point toward business behavior, explicit contracts, and changes that can be tested without booting the whole application.

## Workflow

Use the shared [change review guidance](../../../../SnackTrackApp/.agents/skills/snacktrack-codebase-navigation/references/reviewing-changes.md) to choose the scope of the fix and its verification.

1. Use `snacktrack-codebase-navigation` to trace the current route → service → repository/adapter → tests path and find all callers.
2. State the use case, invariant, authoritative owner, inputs, outputs, and failure modes before choosing files or abstractions.
3. Read only the references needed for the change:
   - dependency direction, layers, composition, and module ownership: [references/architecture-boundaries.md](references/architecture-boundaries.md)
   - TypeScript types, functions, classes, naming, and maintainability: [references/types-and-code-design.md](references/types-and-code-design.md)
   - HTTP/provider contracts, errors, configuration, and logging: [references/contracts-errors-observability.md](references/contracts-errors-observability.md)
   - cleanup planning, smell prioritization, and safe incremental refactoring: [references/refactoring-and-review.md](references/refactoring-and-review.md)
   - test seams, regression placement, and definition of done: [references/testing-and-definition-of-done.md](references/testing-and-definition-of-done.md)
4. Choose the narrowest cohesive owner. Prefer improving a touched boundary over introducing a parallel abstraction or reorganizing unrelated files.
5. Keep behavior changes and structural cleanup separable in the diff when practical. Preserve API, database, and provider compatibility unless the task explicitly changes a contract.
6. Add or update regression coverage at the authoritative decision point and affected transport boundary.
7. Run `npm run build` and `npm run lint` from `SnackTrackAPI`; also lint changed/staged tests with the local ESLint binary and `--max-warnings=0`. Fix lint errors and warnings before finishing and re-run affected checks. Tests and other suites remain opt-in.

## Target dependency model

Use responsibilities rather than folder names as the governing rule:

`Express route/middleware → application service/use case → domain logic`

`application service/use case → repository or external-provider port`

The composition root constructs concrete PostgreSQL, Redis capability, queue, object-storage, email, OAuth, and provider adapters. The API, worker, and scheduler entrypoints own process lifecycle. Application services depend on the narrow capabilities in `src/services/ports/`; pure domain logic remains independent of infrastructure. Inner business logic must not depend on Express request/response objects, global singletons, environment variables, database drivers, BullMQ jobs, or vendor response shapes.

## Core rules

- Give each business decision one authoritative owner; call it instead of copying its rules.
- Keep routes thin: authenticate, validate, invoke one use case, translate its result, and send the response.
- Keep orchestration in services and persistence in repositories. Keep calculations, normalization, matching, and selection pure when they do not require I/O.
- Inject side-effecting dependencies through explicit typed constructors or function parameters. Do not add string-keyed service lookup, `any`-typed dependencies, or hidden singleton access to new code.
- Parse `unknown` at system boundaries and expose validated internal types. Do not use type assertions to make unverified data appear safe.
- Model meaningful states with enums or discriminated unions instead of related booleans, magic strings, or sentinel values.
- Return domain/application results from services; do not return Express responses or leak PostgreSQL/provider objects across boundaries.
- Preserve stable machine-readable errors and structured logs. Never swallow failures, log secrets, or use `console.log` in production paths.
- Remove duplication by centralizing policy, not by creating generic helpers that erase domain meaning.
- Comments explain invariants, tradeoffs, or external constraints. Names and structure explain what the code does.
- Do not create interfaces, factories, base classes, or wrappers without a real substitution point, boundary, or repeated use case.

## Established architecture policy

The typed composition root, application ports, route factories, versioned migrations, durable import jobs/outbox, canonical error envelope, and structured telemetry are established production boundaries. Preserve them rather than treating them as aspirational migration targets.

- New behavior follows the dependency model and extends an existing port or adds a narrow new one at a real volatile/test boundary.
- A meaningful change repairs the complete touched boundary when safe and covered; do not recreate route SQL, concrete adapter imports in application services, or resource singletons.
- Compatibility adapters require an active caller, a named rollout gate, and one-way ownership toward the canonical contract.
- Delete old paths only after all callers, scheduled writers, tests, runtime registration, and app normalizers have been checked.
- Run `npm run check:architecture` only when the user requests architectural verification; its forbidden-import and cycle rules are the executable backstop.

## Handoff

Report the use-case owner, dependency path, contract/error effects, test seam and regression coverage, TypeScript check result, and any intentionally retained compatibility gate. For cleanup work, distinguish completed structural improvements from remaining risks rather than claiming unrelated areas are clean.
