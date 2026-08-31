# TypeScript and code design

Use this reference when shaping types, functions, classes, public APIs, naming, or local code structure.

## Boundary-first types

Treat database rows, environment variables, request inputs, uploaded files, decoded tokens, and provider payloads as untrusted boundary data.

- Accept `unknown` when the runtime shape is not guaranteed, then validate/narrow once.
- Keep transport DTOs, provider DTOs, persistence rows, and internal domain types conceptually distinct even when fields currently match.
- Normalize dates, currency units, identifiers, nullability, and enum values at the boundary.
- Avoid `as`, non-null assertions, and optional chaining that merely conceal an invalid state. Narrow or fail with a defined error.
- Avoid `any`. If a legacy library forces it, contain it in one adapter and return a safe type.
- Use `readonly` inputs/collections where mutation is not part of the contract.

Do not create duplicate hand-maintained types for the same internal concept. Place shared types at the narrowest stable owner, not automatically in a global `types` file.

## Model states and results

Prefer types that make invalid states difficult to express.

- Use discriminated unions for lifecycle or outcome variants.
- Use one enum/union rather than multiple booleans whose combinations require explanation.
- Use explicit result objects when success has meaningful variants or expected failures are part of control flow.
- Reserve exceptions for failures that unwind the operation; do not mix sentinel returns, thrown strings, and nullable values for the same failure family.
- Distinguish absent, unknown, empty, declined, and failed when the product treats them differently.

Avoid boolean parameters at call sites when their meaning is unclear. Prefer an options object or intent-named operation.

## Functions

A function should operate at one level of abstraction and have a name that describes its outcome.

- Use guard clauses for invalid or terminal cases.
- Separate parsing, policy decisions, persistence, and response mapping when they can change independently.
- Pass the values a function needs rather than a broad context object unless that context is a deliberate stable contract.
- Avoid hidden mutation of arguments or module state.
- Extract helpers when they name a real concept, remove duplication, or isolate complexity—not merely to reduce line count.
- Keep the main use-case flow readable from top to bottom; move incidental mechanics behind intent-revealing operations.

If a function needs many unrelated parameters, inspect whether ownership is misplaced. Do not automatically replace them with an untyped bag.

## Classes and services

Use a class when the object has injected collaborators, lifecycle, or meaningful state. Prefer functions/modules for stateless transformations.

- Keep constructor work to dependency assignment and cheap invariant checks; do not perform network or database I/O.
- Make dependencies explicit and narrow.
- Avoid public mutable fields and method sequences that place correctness on the caller.
- Avoid inheritance for code reuse. Prefer composition and small policies/adapters.
- Do not expose private internals solely for tests; test public behavior or extract a pure collaborator.

## Naming and structure

- Name operations with verbs and domain outcomes; name values with domain nouns.
- Use `Repository` for persistence boundaries, `Client`/`Adapter` for external systems, `Service` for cohesive application/domain behavior, and `Controller` only if a real transport controller abstraction exists.
- Avoid vague names such as `data`, `info`, `manager`, `helper`, `processor`, or `handleThing` when a domain term exists.
- Keep terminology consistent across route, service, database, and client contracts.
- Keep imports grouped and direct. Avoid deep cross-domain imports and barrels that hide ownership.

## Duplication and abstraction

There are two different kinds of duplication:

- duplicated policy or invariant should usually have one owner;
- coincidentally similar mechanics may remain separate until their reasons to change align.

Prefer a small domain-specific abstraction over a configurable framework. Reject abstractions that require flags, callbacks, or generic parameters merely to recreate each original call site.

## Comments and dead code

Comments should capture why: invariants, provider quirks, concurrency assumptions, units, security decisions, or intentional legacy compromises. Delete comments that narrate obvious syntax or no longer match behavior.

Do not retain commented-out code, unused exports, speculative extension points, or compatibility wrappers without active callers. Before deletion, search runtime registration, scheduled jobs, dynamic string references, tests, scripts, and the sibling app contract.

## Local cleanliness check

Before handing off, look for:

- `any`, unsafe assertions, swallowed errors, and ambiguous nulls;
- copied state/eligibility/error rules;
- broad services or parameter bags gaining another responsibility;
- I/O mixed into otherwise pure logic;
- magic strings, numbers, time units, or cache keys;
- misleading names and stale comments;
- new circular or reverse-layer dependencies; and
- obsolete code left behind after migration.
