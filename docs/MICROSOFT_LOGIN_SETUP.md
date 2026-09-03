# Microsoft identity login

Microsoft identity login and Outlook receipt importing are separate integrations. Login uses a
native public client with OpenID scopes only. Outlook importing uses the confidential server client,
client secret, Graph scopes, and mailbox connection records documented in `OUTLOOK_OAUTH_SETUP.md`.

## Entra registration

Use the existing SnackTrack Entra tenant, but register a dedicated public mobile application for
login. Support accounts in any organizational directory and personal Microsoft accounts. Enable
public-client flows, create no client secret, and request only `openid profile email`.

Register the exact native redirects for every signed build:

- iOS: `msauth.com.snacktrack.mobile://auth`
- Android: `msauth://com.snacktrack.app/<URL-encoded signing-certificate-hash>`

Development, preview, and production Android certificates can require separate redirect entries.
Add the optional ID-token claim `verified_primary_email`. SnackTrack treats a valid value as the
trusted account email, so eligible first-time users skip the SnackTrack code step. The `email` plus
`xms_edov=true` combination is also trusted. If Microsoft supplies only an unverified email and it
is not already in use, SnackTrack creates the Microsoft-linked account with `emailVerified=false`
and lets the user verify later from Profile. Verification remains mandatory before an untrusted
email can link to an existing SnackTrack account.

## Configuration

API:

```dotenv
MICROSOFT_LOGIN_CLIENT_ID=
MICROSOFT_LOGIN_ENABLED=false
```

Expo/EAS:

```dotenv
EXPO_PUBLIC_MICROSOFT_LOGIN_CLIENT_ID=
EXPO_PUBLIC_MICROSOFT_LOGIN_IOS_REDIRECT_URI=
EXPO_PUBLIC_MICROSOFT_LOGIN_ANDROID_REDIRECT_URI=
```

Missing values keep the login button hidden and the API capability unavailable. Redirect-scheme
changes require new native builds; Expo Go is not a supported final verification environment.

Microsoft access and refresh tokens are never persisted. The app discards the Microsoft token
response after exchanging the ID token for the ordinary SnackTrack access and refresh tokens.

## Verification checklist

- Personal Outlook.com account can create and restore a SnackTrack session.
- Organizational Microsoft 365 account can create and restore a session.
- An existing SnackTrack account is linked only by a domain-owner-verified Microsoft email or a
  successfully entered SnackTrack email code.
- A returning linked identity works when Microsoft later omits the email claim.
- Denied consent, invalid/expired attempts, invalid codes, and JWKS outages produce retryable,
  machine-readable errors without clearing an existing local session.
- Signing in does not request `Mail.Read`, create a mailbox connection, or start a receipt import.

References: [authorization code with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), and
[ID-token validation](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
