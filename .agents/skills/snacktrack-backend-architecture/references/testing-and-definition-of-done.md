# Testing and definition of done

Use this reference when choosing test seams, adding regression coverage, or determining whether an architecture change is complete.

## Test at the owner

Place the strongest assertion where the behavior is authoritative:

- pure domain policy: table-driven unit tests over values and state variants;
- application service: collaborators as controlled fakes/stubs, asserting result, sequencing, and meaningful side effects;
- repository: SQL behavior and row mapping against the repository contract;
- provider adapter: provider payload/error translation and pagination/retry boundaries;
- route: authentication/ownership, validation, HTTP status, stable error code, and response shape;
- composition: a small wiring check when registration/lifecycle is the risk.

Do not duplicate every assertion at every layer. Route tests should not re-prove detailed domain calculations, and domain tests should not know HTTP status codes.

## Design for testability

- Inject I/O dependencies, clocks, ID generators, and configurable policies where determinism matters.
- Prefer public behavior over private-method tests.
- Extract a pure collaborator when testing a private method would otherwise be necessary.
- Use realistic domain values and failure modes; avoid mocks that only assert an implementation called methods in the current order.
- Keep test fixtures/builders domain-named and minimal. A fixture should not hide the state relevant to the assertion.
- Avoid global mutable test setup that makes order significant.

## Regression expectations

Every bug fix should make the old failure observable in a regression test at its owner. Every new contract variant should cover success and its meaningful expected failures. Refactoring should preserve or add characterization around behavior at risk.

For persistence, caches, transactions, locks, migrations, or races, use `snacktrack-backend-engineering`; its stronger postcondition and concurrency requirements apply in addition to this reference.

## Ordinary verification

Run from `SnackTrackAPI`:

```sh
npm run build
```

Do not run focused tests, `npm test`, lint, or full suites unless the user explicitly requests them. Adding tests does not imply permission to execute them. Inspect `git diff --check` and the final diff.

## Definition of done

A backend architecture/code-design change is complete when:

- the use case and authoritative owner are clear;
- route, application, domain, and infrastructure responsibilities are not newly mixed;
- new dependencies are explicit and typed;
- boundary data is validated/normalized before internal use;
- success and failure contracts remain intentional and stable;
- logging/configuration follow shared infrastructure and protect secrets;
- replaced code, exports, and registrations are removed when no longer called;
- regression coverage exists at the authoritative decision point and affected contract boundary;
- the API TypeScript build passes; and
- retained legacy boundaries and manual verification needs are stated honestly.
