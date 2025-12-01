# Gmail OAuth Setup Guide

This guide walks you through setting up Gmail OAuth for the SnackTrack API Gmail integration feature.

## Prerequisites

- Google Cloud Platform account
- SnackTrack API running locally or deployed
- Access to your deployment's environment variables

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Enter project name: "SnackTrack" (or your preferred name)
4. Click "Create"

## Step 2: Enable Gmail API

1. In your new project, go to "APIs & Services" → "Library"
2. Search for "Gmail API"
3. Click on "Gmail API"
4. Click "Enable"

## Step 3: Create OAuth 2.0 Credentials

### Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select "External" (unless you have a Google Workspace)
3. Click "Create"

**App Information:**
- App name: `SnackTrack`
- User support email: Your email
- Developer contact: Your email

**Scopes:**
- Click "Add or Remove Scopes"
- Add: `https://www.googleapis.com/auth/gmail.readonly`
- Click "Update"

**Test Users (for development):**
- Add your Gmail address that you'll use for testing
- Click "Save and Continue"

### Create OAuth Client ID

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: "Web application"
4. Name: "SnackTrack Web Client"

**Authorized JavaScript origins:**
- Development: `http://localhost:3000`
- Production: `https://your-domain.com`

**Authorized redirect URIs:**
- Development: `http://localhost:3000/gmail/callback`
- Production: `https://your-domain.com/gmail/callback`

5. Click "Create"
6. **Copy the Client ID and Client Secret** (you'll need these)

## Step 4: Configure Environment Variables

Add these to your `.env` file:

```bash
# Gmail OAuth Configuration
GMAIL_CLIENT_ID=your_client_id_from_step_3
GMAIL_CLIENT_SECRET=your_client_secret_from_step_3
GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback
```

**For Production:**
```bash
GMAIL_REDIRECT_URI=https://your-production-domain.com/gmail/callback
```

## Step 5: Restart Your Application

```bash
# If running with Docker
docker-compose restart

# If running with npm
npm run dev
```

## Step 6: Test the Integration

### Option 1: Using curl and browser

1. **Get an access token:**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your-email@example.com","password":"your-password"}'
```

2. **Get the OAuth URL:**
```bash
curl -i -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3000/gmail/connect
```

3. **Open the redirect URL in your browser** (look for the `Location:` header)

4. **Authorize the application** in the Google OAuth screen

5. **Import receipts:**
```bash
curl -X POST http://localhost:3000/gmail/import \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replaceExisting": false}'
```

### Option 2: Using the test script

```bash
cd tests
./test-gmail-integration.sh
```

Follow the instructions to manually connect Gmail in your browser.

## Step 7: Verify Connection

```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3000/gmail/status
```

Expected response:
```json
{
  "connected": true,
  "email": "your-email@example.com"
}
```

## Common Issues

### Issue: "redirect_uri_mismatch" error

**Cause:** The redirect URI in your request doesn't match the authorized redirect URIs in Google Cloud Console.

**Solution:**
1. Check your `GMAIL_REDIRECT_URI` environment variable
2. Ensure it exactly matches one of the authorized redirect URIs in Google Cloud Console
3. Common mistakes:
   - Missing/extra trailing slash
   - http vs https
   - localhost vs 127.0.0.1
   - Different port numbers

### Issue: "No refresh token received"

**Cause:** User has already authorized the app once.

**Solution:**
1. Go to https://myaccount.google.com/permissions
2. Find "SnackTrack" in the list
3. Click "Remove Access"
4. Try connecting again

OR

The OAuth request must include:
- `access_type: 'offline'`
- `prompt: 'consent'`

These are already set in the code (`src/routes/gmail.ts`).

### Issue: "Access blocked: This app's request is invalid"

**Cause:** OAuth consent screen not properly configured.

**Solution:**
1. Go to "APIs & Services" → "OAuth consent screen"
2. Make sure you've added the Gmail readonly scope
3. Add your email as a test user (for external apps)
4. Save changes

### Issue: "Gmail not connected" when trying to import

**Cause:** User hasn't completed the OAuth flow.

**Solution:**
1. Call `GET /gmail/connect` first
2. Complete the OAuth flow in the browser
3. Then try `POST /gmail/import`

## Security Best Practices

### Development
- Use `http://localhost:3000` for local testing
- Add your test email to the OAuth consent screen test users
- Keep your client secret in `.env` (never commit it)

### Production
- Always use HTTPS (`https://your-domain.com`)
- Store credentials in environment variables (Railway, Heroku, etc.)
- Never expose client secret in frontend code
- Regularly rotate credentials
- Monitor OAuth usage in Google Cloud Console

## Testing with Multiple Users

Each user can connect their own Gmail account:

1. User A registers and logs in → connects their Gmail → imports receipts
2. User B registers and logs in → connects their Gmail → imports receipts
3. Each user only sees their own receipts

The tokens are stored per-user in the database.

## Scopes Explained

`https://www.googleapis.com/auth/gmail.readonly`
- Read-only access to Gmail
- Cannot send emails
- Cannot modify emails
- Cannot delete emails
- Can only read email content

This is the minimal scope needed for receipt parsing.

## Cost Considerations

**Gmail API Free Tier (as of 2024):**
- 1 billion quota units per day
- Reading emails: 5 units per request
- You can fetch ~200 million emails per day for free

For SnackTrack typical usage:
- Average user has ~100-200 Uber Eats emails
- Importing once = ~100-200 API calls = 500-1000 units
- You can support thousands of imports per day within free tier

**No cost for most use cases!**

## Monitoring OAuth Usage

Track your usage in Google Cloud Console:

1. Go to "APIs & Services" → "Dashboard"
2. Click "Gmail API"
3. View graphs for:
   - Requests
   - Errors
   - Latency

Set up alerts if you approach quota limits.

## Next Steps

- ✅ Gmail OAuth is configured
- ✅ Users can connect their Gmail
- ✅ Receipts can be imported from email

**Optional enhancements:**
- Add scheduled imports (cron jobs)
- Add webhook notifications for new emails
- Support multiple email providers (Outlook, etc.)
- Add email receipt forwarding

## Support

If you encounter issues:

1. Check Google Cloud Console for error messages
2. Review application logs for detailed errors
3. Verify all redirect URIs match exactly
4. Test with the provided test scripts
5. Check that Gmail API is enabled in your project

## Resources

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Gmail API Documentation](https://developers.google.com/gmail/api)
- [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) (for testing)
- [SnackTrack Gmail Integration Docs](../GMAIL_INTEGRATION.md)

