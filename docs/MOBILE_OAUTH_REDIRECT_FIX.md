# Mobile OAuth Redirect URI Fix

## Problem

Google OAuth was rejecting `snacktrack://oauth/callback` as a redirect URI with error:
```
Error 400: invalid_request
redirect_uri=snacktrack://oauth/callback
```

## Root Cause

Google OAuth clients have specific requirements for redirect URIs:

1. **Web OAuth clients** only accept `http://` or `https://` URIs (plus `localhost`)
2. **Android OAuth clients** use a special format: `com.googleusercontent.apps.YOUR_CLIENT_ID:/oauth2redirect`
3. **Custom schemes** like `snacktrack://` are NOT accepted as redirect URIs

## Solution

Use a **Web OAuth client** with an HTTP redirect URI, and let `WebBrowser.openAuthSessionAsync` handle the deep link redirect.

### How It Works

1. **Backend** generates OAuth URL with `redirect_uri=http://localhost` (HTTP URL)
2. **Frontend** calls `WebBrowser.openAuthSessionAsync(authUrl, 'snacktrack://oauth/callback')`
3. Browser opens Google OAuth
4. User authorizes
5. Google redirects to `http://localhost?code=xxx`
6. `WebBrowser.openAuthSessionAsync` intercepts this and redirects to `snacktrack://oauth/callback?code=xxx`
7. App receives the deep link and processes it

### Changes Made

**Backend (`src/routes/gmail.ts`):**
- Changed mobile redirect URI from `snacktrack://oauth/callback` to `http://localhost`
- This is the redirect URI sent to Google (must be HTTP)

**Frontend (`components/GmailConnection.tsx`):**
- Still uses `snacktrack://oauth/callback` as the return URL for `WebBrowser.openAuthSessionAsync`
- This is the deep link the app receives (custom scheme is fine here)

## Configuration

### Google Cloud Console

**Web OAuth Client** (used for both web and mobile):
- **Type**: Web application
- **Authorized redirect URIs**:
  - `http://localhost` (for mobile)
  - `http://localhost:8082/oauth-callback` (for web)
  - `https://your-production-domain.com/oauth-callback` (for production)

**Note:** You can use the same Web OAuth client for both web and mobile, or create separate ones.

### Environment Variables

**Backend `.env`:**
```bash
# Use Web OAuth client for mobile (not Android OAuth client)
GMAIL_MOBILE_CLIENT_ID=your_web_client_id_here
GMAIL_WEB_CLIENT_ID=your_web_client_id_here
GMAIL_WEB_CLIENT_SECRET=your_web_client_secret_here

# Redirect URIs
WEB_REDIRECT_URI=http://localhost:8082/oauth-callback
MOBILE_REDIRECT_URI=http://localhost
```

**Important:** `MOBILE_REDIRECT_URI` should be an HTTP URL, not a custom scheme.

## Testing

1. **Update `.env`** with the new redirect URI
2. **Restart backend**
3. **Test on Android:**
   ```bash
   cd SnackTrackApp
   npm start
   # Press 'a' for Android
   # Navigate to Upload → Import from Gmail → Connect Gmail
   ```

The OAuth flow should now work correctly!

## Why This Works

- Google accepts `http://localhost` as a redirect URI (it's a valid HTTP URL)
- `WebBrowser.openAuthSessionAsync` intercepts the HTTP redirect and converts it to the deep link
- The app receives `snacktrack://oauth/callback?code=xxx` via deep linking
- Everything works seamlessly!

## Alternative: Android OAuth Client

If you want to use an Android OAuth client instead, you would need to:

1. Create an Android OAuth client in Google Cloud Console
2. Use the special redirect format: `com.googleusercontent.apps.YOUR_CLIENT_ID:/oauth2redirect`
3. Update the backend to use this format

However, using a Web OAuth client with `http://localhost` is simpler and works well with `WebBrowser.openAuthSessionAsync`.



