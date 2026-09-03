# Session and provider contracts

Read this reference for credential login, an external identity provider, JWT/session behavior, logout, or app restoration.

## API ownership

- `routes/auth.ts` validates requests and delegates to credential, provider, session, and account-deletion capabilities.
- `services/auth/CredentialAuthService.ts` owns registration and password login.
- `services/auth/ProviderAuthService.ts` owns verified provider identity lookup/linking and session issuance.
- `services/auth/IdentityProvider.ts` isolates provider-token verification and maps vendor claims to `VerifiedProviderIdentity`.
- `services/auth/TokenService.ts` owns JWT creation, runtime claim decoding, expiry classification, and refresh-token revocation.
- `services/auth/SessionService.ts` owns refresh rotation, logout revocation, and session validation.
- `services/ports/AuthPorts.ts` is the application-facing persistence/token/email capability boundary.
- `services/data/UserRepository.ts` and `OAuthRepository.ts` implement identity persistence; do not import them directly from application services.

## Canonical session and errors

Auth success returns one required shape:

```text
{ userId, email, accessToken, refreshToken,
  user: { id, email, emailVerified, createdAt } }
```

Use the version-1 operational error envelope. Preserve distinctions including invalid credentials, provider authentication failure, account conflict, access-token expired/invalid, and refresh-token expired/invalid/revoked. HTTP status mapping belongs to the central transport mapper.

## Provider identity rules

- Keep the provider subject as the durable external identifier; email is mutable metadata and an account-linking input only when the verifier establishes it as trustworthy.
- Runtime-decode every provider token/claim payload. Vendor SDK types are not proof that runtime values are valid.
- Normalize provider names through the canonical auth-provider type; avoid casing aliases or provider-specific branches outside the adapter/composition boundary.
- Resolve unique-email and provider-link races transactionally or through stable persistence conflicts; never create duplicate SnackTrack users after concurrent sign-ins.
- Provider login does not grant inbox access. Microsoft identity sign-in and Microsoft Graph mail connection must use separate requested scopes, stored credentials, callbacks, and user consent.

## App ownership

- `services/authApi.ts` performs requests and delegates untrusted response parsing to `services/normalizers/authNormalizers.ts`.
- `contexts/UserContext.tsx` owns authenticated identity and session establishment/teardown.
- `utils/tokenManager.ts` stores sensitive tokens in SecureStore on native and validates the non-sensitive stored user shape.
- `services/api/client.ts` coordinates refresh; `services/authSessionCoordinator.ts` broadcasts only terminal session expiry.
- `features/auth/contracts.ts` maps stable error codes into retry, verification, or terminal behavior.

Temporary connectivity failure during restoration or refresh must retain a locally valid session. Clear auth storage, user-bound query data, and Sentry identity only for confirmed logout, committed deletion, or a terminal refresh/session code.
