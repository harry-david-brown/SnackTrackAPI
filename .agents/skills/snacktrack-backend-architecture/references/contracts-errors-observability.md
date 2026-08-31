# Contracts, errors, configuration, and observability

Use this reference when changing HTTP behavior, provider integrations, error handling, configuration, or logs.

## HTTP contracts

Define before implementation:

- authenticated actor and resource ownership;
- normalized input shape and validation failures;
- success status/body and whether the operation is idempotent;
- stable error status, code, and safe message;
- retry/conflict semantics;
- side effects and committed postcondition; and
- compatibility implications for `SnackTrackApp`.

Validate at the transport boundary, but place business invariants in the authoritative application/domain owner. Never trust a body `userId` over authenticated identity. Do not serialize internal errors, SQL details, stack traces, tokens, or provider payloads.

Keep response mapping explicit. Avoid returning database rows directly or spreading internal objects into API responses, which makes accidental contract expansion easy.

## External-provider contracts

Provider clients/adapters should own:

- SDK/API request construction;
- timeout, pagination, and provider-specific retry behavior;
- runtime validation and normalization of responses;
- translation from provider errors into internal error categories; and
- redaction of credentials and sensitive payloads.

Business services should depend on internal capabilities and types rather than Gmail/Google, SendGrid, Redis, or other vendor SDK types. Keep retry ownership in one layer so nested retries do not multiply requests.

## Error design

Use a consistent application error shape with a stable machine-readable code and enough internal context for diagnosis. Separate the public representation from the logged/captured cause.

Distinguish at least:

- malformed or invalid input;
- unauthenticated or unauthorized access;
- not found;
- conflict/concurrent operation;
- provider reconnect or transient provider failure;
- rate/availability limits; and
- unexpected server failure.

Catch an error only to recover, add useful context, translate it at a boundary, or guarantee cleanup. Preserve the original cause when translating. Never catch merely to log and continue with a false success.

Expected operational failures should not all become status 500. Conversely, do not expose precise internal causes when the client has no safe action to take.

## Logging and telemetry

Use the configured structured logger and existing Sentry/monitoring path.

- Log events, not prose fragments: operation, outcome, stable error code, relevant counts/durations, and safe identifiers.
- Include request/operation correlation context when available.
- Log once at the layer that owns operational handling; repeated logging at every rethrow creates noise.
- Choose severity by actionability: debug for diagnostic detail, info for meaningful lifecycle events, warn for recovered/degraded behavior, error for failed operations needing investigation.
- Never log passwords, tokens, OAuth codes, credential values, raw email content, full uploaded files, connection strings, or unrelated user data.
- Prefer bounded counts and metadata over large serialized objects.

Metrics should describe outcomes and latency without becoming a second source of business state.

## Configuration

Treat `src/config/AppConfig.ts` and dedicated config modules as the boundary for environment input.

- Read, parse, validate, and default environment variables centrally.
- Fail fast at startup for missing required production configuration.
- Represent durations, byte limits, and numeric thresholds in explicit units.
- Inject configuration or a narrow options object; do not scatter `process.env` reads through services.
- Keep secrets out of defaults, source control, errors, and logs.
- Document new environment variables in the repository’s environment documentation.

## Security and privacy review

For every changed contract, check authenticated ownership, parameterized SQL, upload/path safety, bounded work, rate limiting where abuse is plausible, secret redaction, and least-data responses. Load the specialized account-data or import skill when those domains apply.
