# Gmail Integration - Quick Start

## 🚀 5-Minute Setup

### 1. Get Google OAuth Credentials (5 min)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create project → Enable Gmail API
3. Create OAuth 2.0 credentials (Web application)
4. Add redirect URI: `http://localhost:3000/gmail/callback`
5. Copy Client ID and Client Secret

### 2. Configure Environment (30 sec)

Add to your `.env`:
```bash
GMAIL_CLIENT_ID=your_client_id_here
GMAIL_CLIENT_SECRET=your_client_secret_here
GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback
```

### 3. Restart Server (10 sec)

```bash
docker-compose restart
# or
npm run dev
```

### 4. Test It! (2 min)

```bash
# 1. Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpass"}' \
  | jq -r '.accessToken'

# Save the token as TOKEN

# 2. Connect Gmail (open in browser)
# Visit: http://localhost:3000/gmail/connect
# (with Authorization: Bearer $TOKEN header or while logged in)

# 3. Import receipts
curl -X POST http://localhost:3000/gmail/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replaceExisting": false}' \
  | jq '.'
```

## 📋 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/gmail/connect` | GET | Start OAuth flow |
| `/gmail/callback` | GET | OAuth callback (auto) |
| `/gmail/status` | GET | Check connection |
| `/gmail/import` | POST | Import receipts |
| `/gmail/disconnect` | POST | Disconnect Gmail |

## 🔧 Common Commands

**Check if Gmail is connected:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/gmail/status
```

**Import receipts:**
```bash
curl -X POST http://localhost:3000/gmail/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replaceExisting": false}'
```

**Disconnect Gmail:**
```bash
curl -X POST http://localhost:3000/gmail/disconnect \
  -H "Authorization: Bearer $TOKEN"
```

## 🎯 User Flow

1. **User registers** → `POST /auth/register`
2. **User connects Gmail** → `GET /gmail/connect` (browser)
3. **User authorizes** → Google OAuth screen
4. **Callback stores tokens** → `GET /gmail/callback`
5. **User imports** → `POST /gmail/import`
6. **View receipts** → `GET /receipts?userId=xxx`

## 📖 Full Documentation

- **Complete Guide:** [GMAIL_INTEGRATION.md](./GMAIL_INTEGRATION.md)
- **Setup Steps:** [docs/GMAIL_OAUTH_SETUP.md](./docs/GMAIL_OAUTH_SETUP.md)
- **Implementation:** [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)

## 🐛 Troubleshooting

**"redirect_uri_mismatch"**
→ Check GMAIL_REDIRECT_URI matches Google Console exactly

**"No refresh token received"**
→ Revoke access at https://myaccount.google.com/permissions and try again

**"Gmail not connected"**
→ Must call `/gmail/connect` and complete OAuth first

## 🎉 That's it!

Your users can now import Uber Eats receipts directly from Gmail!

