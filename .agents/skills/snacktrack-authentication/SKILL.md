---
name: snacktrack-authentication
description: Implement and diagnose SnackTrack login, registration, JWT access/refresh sessions, Google/Apple/Microsoft identity sign-in, provider-account linking, email verification, password reset, logout, and authenticated app restoration. Use for auth routes/services, identity-token verification, token rotation/revocation, OTP workflows, UserContext, secure token storage, session-expiry behavior, or adding an identity provider. Do not use mailbox OAuth as login OAuth; load snacktrack-mailbox-integrations for Gmail or Microsoft Graph mail access.
---

# SnackTrack Authentication

Preserve one coherent identity and session contract across SnackTrackAPI and SnackTrackApp.

## Required workflow

1. Use `snacktrack-codebase-navigation` to trace the auth route, application capability, port/adapter, app normalizer, `UserContext`, and focused tests.
2. Classify the task as credential auth, external identity auth, session/token lifecycle, verification/password reset, or local session restoration.
3. Read [references/session-and-provider-contracts.md](references/session-and-provider-contracts.md) for login, provider linking, JWT, refresh, logout, or app restoration.
4. Read [references/verification-workflows.md](references/verification-workflows.md) for email verification or password reset.
5. Load `snacktrack-backend-architecture` for API changes and `snacktrack-frontend-engineering` for app changes. Load `snacktrack-account-data-lifecycle` for account deletion.
6. Define stable success/error contracts and which failures retain or clear the local session before editing.
7. Add regression coverage at the verifier/service decision point and app normalization/session boundary.
8. Run only the relevant TypeScript check unless the user explicitly requests broader verification.

## Core invariants

- Identity-provider login and mailbox access are different products, OAuth clients, scopes, credentials, consent, and lifecycle state. Never reuse a mailbox grant as a login session or infer mailbox permission from login.
- The canonical auth session requires `userId`, `email`, access/refresh tokens, and `user.id`, `user.email`, `user.createdAt`, and `user.emailVerified`.
- Validate JWT claims and provider identity payloads from `unknown`; never trust client-supplied provider email or subject data without verifier evidence.
- Link external identities by stable `(provider, providerUserId)` ownership. Handle verified-email account linking and uniqueness races deliberately.
- Refresh atomically consumes the presented refresh token before issuing its replacement. Distinguish absent, expired, malformed, revoked/replayed, and session-store-unavailable outcomes with stable codes.
- Refresh-token consumption and logout revocation fail closed when the Redis-backed session store is unavailable. `SESSION_STORE_UNAVAILABLE` is retryable and must preserve local credentials; only terminal session failures clear credentials and query state.
- Authentication identity belongs in `UserContext`; receipts, analytics, import preferences, and other server resources remain in TanStack Query.
- Verification-code consumption and the protected mutation share one transaction. Do not verify a code in one operation and mutate the account later.
- Account deletion clears local auth state only after the authoritative server deletion commits.
- Never log passwords, tokens, OAuth codes, raw identity claims, verification codes, or provider credentials.

## Canonical ownership

- API ports: `SnackTrackAPI/src/services/ports/AuthPorts.ts`.
- API capabilities: `SnackTrackAPI/src/services/auth/`, including `SessionService.ts`, `TokenService.ts`, and `AuthenticationActivityService.ts`, plus `OtpService.ts` and focused auth route factories.
- Persistence adapters: `UserRepository.ts`, `OAuthRepository.ts`, and migration `002_auth_and_provider_identity.ts`.
- App boundary: `services/authApi.ts`, `services/normalizers/authNormalizers.ts`, `features/auth/contracts.ts`, `contexts/UserContext.tsx`, `services/authSessionCoordinator.ts`, and `utils/tokenManager.ts`.

## Handoff

Report the identity/session owner, provider distinction, token/OTP transaction behavior, stable errors, local-session clearing policy, regression seam, TypeScript result, and any manual provider-console or device verification still required.
