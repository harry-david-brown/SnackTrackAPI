# Refactoring and architecture review

Use this reference for cleanup requests, broad code reviews, service extraction, or migration toward the target architecture.

## Begin with evidence

Map the current behavior before proposing a target:

1. locate runtime entry points and composition registration;
2. trace callers and downstream dependencies;
3. identify the authoritative behavior and duplicated versions;
4. identify side effects, transactions, caches, locks, jobs, and provider calls;
5. read focused tests and cross-stack contracts; and
6. distinguish observed behavior from inferred intent.

Do not assess cleanliness from file length alone. Complexity may be essential; hidden coupling in a short file may be the larger risk.

## Prioritize smells by impact

Use this order unless the task supplies a different priority:

1. correctness/security risks: missing ownership, swallowed errors, invalid transaction or lock boundaries;
2. multiple sources of truth and duplicated policy;
3. hidden dependencies, global state, and reverse-layer coupling;
4. unvalidated/unsafe types at boundaries;
5. modules with unrelated responsibilities or poor test seams;
6. duplication, naming, comments, and formatting issues.

Record each finding with evidence, affected behavior, proposed owner, migration risk, and verification seam. Avoid vague findings such as “too complex” without a concrete consequence.

## Choose a refactoring seam

Good seams include one route use case, one policy calculation, one repository boundary, one provider adapter, or one error family. A seam should produce an observable improvement and permit verification without migrating the entire repository.

Common transformations:

- extract pure policy from an I/O-heavy service;
- move SQL from route/service into a domain-named repository operation;
- replace copied rules with one typed resolver/policy;
- wrap a provider SDK behind an internal port;
- inject a clock, cache, repository, or client instead of importing a singleton;
- replace boolean combinations or magic strings with a discriminated union;
- split one application operation from a broad service; and
- extend the typed composition root and narrow port for the touched dependency path.

## Preserve behavior deliberately

- Add characterization coverage when important legacy behavior is not already explicit.
- Keep public route shapes, stable error codes, database semantics, scheduling, and cache behavior unchanged unless the task says otherwise.
- Refactor one responsibility axis at a time when mixing axes would obscure review.
- Do not introduce a new path while leaving both paths authoritative.
- Keep compatibility adapters one-way and temporary; identify remaining callers.
- Delete dead code only after checking static callers, runtime wiring, jobs, scripts, and tests.

If cleanup reveals a functional bug, report it separately. Fix it only when within the requested scope or when the cleanup cannot be made correct without doing so.

## Avoid cleanup traps

- Repository-wide folder moves before dependency direction is understood.
- A “base service” or generic repository that erases domain operations.
- Replacing one god object with a service locator or oversized context object.
- Creating interfaces for every class without a boundary or substitution need.
- Extracting tiny helpers that force readers to jump files without naming a concept.
- Converting all errors to one generic error and losing recovery semantics.
- Adding lint suppressions, `as` assertions, or optional chaining instead of resolving invalid state.
- Large formatting churn mixed with behavioral changes.

## Review checklist

Ask:

- Is there one clear owner for each decision and state transition?
- Does dependency direction point from transport toward domain behavior?
- Are I/O boundaries explicit, injected, and typed?
- Can the core decision be tested without Express, PostgreSQL, Redis, or a provider?
- Are public contracts narrower than internal representations?
- Are errors actionable, stable, and safely logged?
- Does the change remove the replaced path and stale exports?
- Is the abstraction simpler for the next likely change, not merely more patterned?
- Did the diff stay within the chosen seam and preserve unrelated user work?

## Cleanup-plan output

For a future cleanup audit, produce an ordered plan with:

- current ownership/dependency map;
- concrete findings with file evidence;
- target responsibility and dependency direction;
- incremental slices and prerequisites;
- contracts and behaviors that must remain stable;
- regression seams and build/manual checks; and
- deferred areas explicitly outside the cleanup.
