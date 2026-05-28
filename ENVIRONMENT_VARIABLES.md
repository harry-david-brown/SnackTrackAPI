# Environment Variables Configuration

This document lists all environment variables used by the SnackTrack API.

## Required Variables

### Server Configuration
```bash
PORT=3000                    # Port for the API server
NODE_ENV=development         # Environment: development, production, test
```

### Database Configuration
```bash
# Option 1: Connection URL
DATABASE_URL=postgresql://user:password@localhost:5432/snacktrack

# Option 2: Individual components
DB_HOST=localhost
DB_PORT=5432
DB_NAME=snacktrack
DB_USER=user
DB_PASSWORD=password
```

### Authentication
```bash
# JWT Secrets (generate secure random strings in production)
JWT_SECRET=your-jwt-secret-here
REFRESH_SECRET=your-refresh-secret-here
```

## Optional Variables

### Redis (Caching)
```bash
REDIS_URL=redis://localhost:6379
```

### Email Service (SendGrid)
```bash
SENDGRID_API_KEY=your-sendgrid-api-key
EMAIL_FROM=noreply@snacktrack.app
```

### Gmail OAuth (Gmail Import Feature)
```bash
GMAIL_CLIENT_ID=your-gmail-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-gmail-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
```

**Setup Guide**: See `GMAIL_OAUTH_SETUP.md` for detailed configuration instructions.

### Apple Sign In (Apple Authentication)
```bash
APPLE_CLIENT_ID=com.snacktrack.mobile.signin
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_KEY_ID=YOUR_KEY_ID
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
YOUR_PRIVATE_KEY_HERE
-----END PRIVATE KEY-----"
```

**Setup Guide**: See `APPLE_DEVELOPER_SETUP_GUIDE.md` for detailed configuration instructions.

**Important Notes**:
- `APPLE_CLIENT_ID`: Your Services ID from Apple Developer Console
- `APPLE_TEAM_ID`: Your Apple Developer Team ID
- `APPLE_KEY_ID`: The Key ID from your Sign in with Apple Key
- `APPLE_PRIVATE_KEY`: The contents of your `.p8` file (keep newlines or use `\n`)

### Error Tracking (Sentry)
```bash
SENTRY_DSN=your-sentry-dsn
```

### Logging (Logtail)
```bash
LOGTAIL_SOURCE_TOKEN=your-logtail-token
```

### CORS Configuration
```bash
CORS_ORIGIN=http://localhost:8081,http://localhost:19006
```

### Rate Limiting
```bash
RATE_LIMIT_WINDOW_MS=900000      # 15 minutes in milliseconds
RATE_LIMIT_MAX_REQUESTS=100      # Max requests per window
```

### Feature Flags
```bash
ENABLE_SWAGGER=true              # Enable Swagger API documentation
ENABLE_RATE_LIMITING=true        # Enable rate limiting middleware
```

## Security Best Practices

1. **Never commit** `.env` files to version control
2. **Use strong secrets** for JWT tokens (at least 32 characters)
3. **Rotate secrets** regularly in production
4. **Use different secrets** for development and production
5. **Store secrets securely** in production (e.g., Railway secrets, AWS Secrets Manager)
6. **Limit CORS origins** to only trusted domains in production

## Generating Secure Secrets

### JWT Secrets
```bash
# Generate a secure random string (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Apple Private Key
```bash
# Convert .p8 file to environment variable format
cat AuthKey_ABC123DEFG.p8 | tr '\n' '\\n'
```

## Environment-Specific Configuration

### Development
- Use local database
- Enable Swagger documentation
- Allow localhost CORS origins
- Use test API keys when possible

### Production
- Use managed database (e.g., Railway PostgreSQL)
- Disable Swagger or protect with authentication
- Restrict CORS to production domains only
- Use production API keys and secrets
- Enable error tracking (Sentry)
- Enable logging (Logtail)

## Validation

The API will validate required environment variables on startup and log warnings for missing optional variables.

### Required for Basic Operation
- `JWT_SECRET`
- `REFRESH_SECRET`
- Database configuration (either `DATABASE_URL` or individual `DB_*` variables)

### Required for Specific Features
- Gmail Import: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
- Apple Sign In: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
- Email: `SENDGRID_API_KEY`, `EMAIL_FROM`
- Caching: `REDIS_URL`

## Troubleshooting

### "JWT_SECRET not configured" Error
- Ensure `JWT_SECRET` is set in your `.env` file
- Check that `.env` file is in the root directory
- Verify `dotenv` is loaded before accessing environment variables

### "Database connection failed" Error
- Check database credentials
- Ensure database server is running
- Verify network connectivity to database

### "Apple Sign In not configured" Error
- Ensure all four Apple variables are set
- Verify private key format (should include BEGIN/END lines)
- Check that client ID matches your Services ID

### "Gmail OAuth not configured" Error
- Ensure `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` are set
- Verify credentials are from Google Cloud Console
- Check that OAuth consent screen is configured

## Example .env File

```bash
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://snacktrack:password@localhost:5432/snacktrack

# Auth
JWT_SECRET=abc123def456ghi789jkl012mno345pqr678stu901vwx234yz
REFRESH_SECRET=zyx987wvu654tsr321qpo098nml765kji432hgf210edc

# Gmail (optional)
GMAIL_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-abcdefghijklmnop

# Apple (optional)
APPLE_CLIENT_ID=com.snacktrack.mobile.signin
APPLE_TEAM_ID=ABC123DEFG
APPLE_KEY_ID=XYZ789HIJK
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49...\n-----END PRIVATE KEY-----"

# Optional services
REDIS_URL=redis://localhost:6379
SENTRY_DSN=https://abc123@sentry.io/456789
```
