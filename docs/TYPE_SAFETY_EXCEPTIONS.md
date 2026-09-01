# Type-safety exceptions

The API lint configuration rejects explicit `any`, unsafe assignment/calls,
floating promises, misused promises, non-Error throws, and console output in
every production TypeScript file.

There are currently no type-safety exceptions. Third-party observability,
provider, request, database, cache, and parsed-file values enter production
code as `unknown` or through typed SDK contracts and are decoded before use.

If an exception ever becomes unavoidable, it must be added here with an exact
file path, owner, reason, and removal gate. A directory-wide or rule-wide
exception is not permitted.
