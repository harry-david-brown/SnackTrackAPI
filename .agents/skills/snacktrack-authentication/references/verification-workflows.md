# Verification and password-reset workflows

Read this reference for email verification, password reset, OTP delivery, expiry, attempt limits, or atomic code consumption.

## Canonical ownership

- `routes/authEmailVerification.ts` and `routes/authPasswordReset.ts` validate transport input and call one workflow capability.
- `services/auth/EmailVerificationService.ts` and `PasswordResetService.ts` own workflow ordering and public results.
- `services/OtpService.ts` owns generation, hashing, expiry, attempt policy, and atomic consume semantics.
- `services/ports/AuthPorts.ts` defines `VerificationCodePort` and `TransactionalEmailPort`.
- `services/email/EmailSender.ts` is a delivery adapter; it must not own verification state.
- App flows live in `EmailVerificationModal.tsx`, `PasswordResetModal.tsx`, and `features/auth/contracts.ts`.

## Invariants

- Requesting a password reset must not reveal whether an email exists.
- Codes are single-purpose (`password_reset` or `email_verification`), short-lived, attempt-limited, hashed at rest, and replaced when a new code is issued.
- Consume the code and update the verified email/password in one transaction. Roll back consumption if the protected mutation fails.
- Preserve stable invalid/not-pending/rate-limit codes so the app can distinguish retryable delivery, invalid/expired entry, and completed state without parsing messages.
- Do not log the email/code pair or include the code in provider metadata beyond the outbound message body.
- Successful email verification updates the authenticated identity; ordinary server resources do not move into `UserContext`.
