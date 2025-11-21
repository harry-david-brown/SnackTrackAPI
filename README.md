# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending through multiple data sources: **Uber CSV imports**, **financial aggregators (Plaid/TrueLayer)**, and **email parsing** as a fallback.

## 📋 Project Progress

### ✅ Core Features Complete
- [x] **Database Setup** - PostgreSQL integration with Docker
- [x] **Receipt Management** - Complete CRUD operations
- [x] **CSV/ZIP Import** - Parse and import Uber Eats data
- [x] **Spending Analytics** - Comprehensive user summaries and insights
- [x] **Wrapped Analytics** - Spotify-style shareable insights (13 viral categories)
- [x] **Email Integration** - Parse receipts from Gmail
- [x] **Restaurant Chain Consolidation** - Smart grouping across locations
- [x] **JWT Authentication** - Secure user authentication and authorization
- [x] **Password Reset** - OTP-based password recovery with email delivery
- [x] **Email Verification** - Secure email verification with 6-digit OTP codes
- [x] **Rate Limiting** - Viral-app-friendly per-user limits
- [x] **API Documentation** - Complete Swagger/OpenAPI docs
- [x] **CI/CD Pipeline** - Automated testing with GitHub Actions

### 🚀 Production Readiness (In Progress)

#### Phase 1: MVP Blockers (Weeks 1-3) ✅
- [x] **Authentication System** - JWT with bcrypt password hashing
- [x] **ZIP File Upload** - Auto-extract Uber data exports
- [x] **Route Protection** - All endpoints secured with ownership validation
- [x] **Improved Rate Limiting** - Per-user limits for viral growth
- [x] **Sentry Integration** - Error tracking and monitoring (free tier ready)
- [x] **Configuration Cleanup** - Removed hardcoded values
- [x] **Health Check Endpoint** - Database connectivity monitoring

#### Phase 2: Performance & Reliability (Weeks 3-4) ✅
- [x] **Database Optimization** - Indexes and connection pooling (20 connections prod, 10 dev)
- [x] **Redis Caching** - Cache user summaries (5min TTL, 36.8% faster)
- [x] **Cache Invalidation** - Automatic on data changes
- [x] **Graceful Shutdown** - Proper connection cleanup
- [x] **Health Checks** - Database latency monitoring
- [x] **Load Testing** - ✅ Validated 1000+ concurrent users (production: p95: 844ms, p99: 908ms)

#### Wrapped Analytics Feature (Week 5) ✅
- [x] **Shame Analytics** - 3am orders, lazy days, order streaks, chain dependency
- [x] **Flex Analytics** - Most expensive order, coffee addiction, night owl stats
- [x] **Comparative Analytics** - Investment calculator, cost equivalents
- [x] **Pattern Analytics** - Peak hours, weekend patterns
- [x] **API Integration** - Optional `?includeWrapped=true` parameter (backward compatible)

#### Phase 3: Monitoring & Operations (Week 6) ✅
- [x] **Centralized Logging** - Winston logger with dynamic log levels (no restart required)
- [x] **Zoom Capability** - Switch to debug mode via API for detailed troubleshooting
- [x] **In-Memory Log Buffer** - Last 1000 logs queryable via API
- [x] **Better Stack Integration** - Optional cloud aggregation for 30+ day retention
- [x] **Sentry Integration** - Complete error tracking and APM with performance monitoring
- [x] **APM Integration** - Application performance monitoring via Sentry
- [x] **Database Backups** - Automated daily backups with retention policy
- [x] **Alerting** - Error rate and performance alerts with health monitoring

#### Phase 4: Scale Preparation (Weeks 7-8)
- [ ] **Async Job Queue** - Background CSV processing
- [ ] **API Versioning** - /v1 prefix for all routes
- [ ] **Pagination** - Handle large datasets efficiently
- [ ] **Load Balancing** - Multi-instance support

### 📊 Current Status
**Timeline:** Phase 1 ✅ | Phase 2 ✅ | Wrapped Analytics ✅ | Phase 3 ✅ | Production Ready! 🚀  
**Load Tested:** 100% success (production: 50 users/1000 req, spike: 1000 users)  
**Performance:** p95: 844ms, p99: 908ms (production), throughput: 125 req/s, wrapped: <30ms  
**Features:** 13 viral-worthy analytics (shame, flex, comparative, patterns)  
**Monitoring:** Structured logging, Sentry APM, automated backups, alerting  
**Deployment:** Validated for Railway/Render (500-1000+ users)  
**Next:** Frontend integration & polish → Production launch

---

## 🚀 Quick Start

**Prerequisites:** Docker and Docker Compose

1. **Clone and start**
   ```bash
   git clone https://github.com/harry-david-brown/SnackTrackAPI
   cd SnackTrackAPI
   docker-compose up --build -d
   ```

2. **Test it works**
   ```bash
   curl http://localhost:3000/
   # Should return: ALIVE
   ```

**That's it!** The API is now running on `http://localhost:3000`

## 🔐 Authentication

**As of Phase 1, Week 1**, the API now uses JWT authentication for all user-specific endpoints.

### Quick Start with Auth
```bash
# 1. Register a new user
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "SecurePass123"}'
# Returns: { userId, accessToken, refreshToken, user }

# 2. Login (if already registered)
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "SecurePass123"}'

# 3. Use token to access protected endpoints
curl -X GET http://localhost:3000/users/{userId}/totalSpent \
  -H "Authorization: Bearer {accessToken}"
```

### Password Requirements
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 number

### Token Management
- **Access Token:** Expires in 15 minutes
- **Refresh Token:** Expires in 7 days
- Use `/auth/refresh` to get new tokens before expiry

### Password Reset Flow
```bash
# 1. Request password reset code
curl -X POST http://localhost:3000/auth/password/reset/request \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# 2. Verify the code (optional - checks if code is valid)
curl -X POST http://localhost:3000/auth/password/reset/verify \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "code": "123456"}'

# 3. Complete password reset with new password
curl -X POST http://localhost:3000/auth/password/reset/complete \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "code": "123456", "newPassword": "NewPassword123"}'
```

### Email Verification Flow
```bash
# 1. Send verification code (triggered after registration or login with unverified email)
curl -X POST http://localhost:3000/auth/email/verify/send \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# 2. Confirm email verification with code
curl -X POST http://localhost:3000/auth/email/verify/confirm \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "code": "123456"}'
```

**Note:** OTP codes expire in 15 minutes. Rate limiting applies to prevent abuse.

## 🔄 CI/CD Pipeline

The project now includes automated CI/CD with GitHub Actions:

### Automated Checks
- ✅ TypeScript compilation
- ✅ Linting (if configured)
- ✅ Docker builds (dev & prod)
- ✅ Security audit
- ✅ PostgreSQL integration testing

### Running Locally
```bash
# Check TypeScript compilation
npm run build

# Run full test suite (14 tests)
cd tests && ./test-full-suite.sh

# Or run individual test suites
cd tests
./test-auth-comprehensive.sh    # Authentication only
./test-cache-performance.sh     # Redis caching
./test-cache-invalidation.sh    # Cache invalidation
```

**Test Documentation:** See [`tests/README.md`](tests/README.md) for details  
**Workflow file:** `.github/workflows/ci.yml`

## 📊 Phase 3: Monitoring & Operations

### Centralized Logging System

All application logs are centralized through Winston logger with dynamic log levels and accessible storage.

**Features:**
- ✅ **Centralized logging** - All logs through Winston logger
- ✅ **Dynamic log levels** - Change at runtime via API (no restart required)
- ✅ **Zoom capability** - Switch to debug mode for detailed troubleshooting
- ✅ **In-memory buffer** - Last 1000 logs queryable via API
- ✅ **Better Stack integration** - Optional cloud aggregation for 30+ day retention

### Quick How-To Guide

#### Viewing Logs

**Railway Dashboard (Real-time):**
```bash
# View logs in Railway dashboard → Service → Logs tab
# Logs are automatically captured from stdout/stderr
# Human-readable format for easy scanning
```

**Via API (Recent Logs):**
```bash
# Get recent logs (last 100 entries)
curl https://snacktrackapi-production.up.railway.app/monitoring/logs

# Filter by log level
curl https://snacktrackapi-production.up.railway.app/monitoring/logs?level=error&limit=50

# Get logs since specific time
curl "https://snacktrackapi-production.up.railway.app/monitoring/logs?since=2025-11-20T10:00:00Z"
```

#### Zooming In on Issues (Dynamic Log Level)

**No restart required** - change log level at runtime:

```bash
# 1. Check current log level
curl https://snacktrackapi-production.up.railway.app/monitoring/log-level
# Returns: { "level": "info", "availableLevels": ["error", "warn", "info", "debug"] }

# 2. Change to debug mode (immediate effect, no restart)
curl -X POST https://snacktrackapi-production.up.railway.app/monitoring/log-level \
  -H "Content-Type: application/json" \
  -d '{"level": "debug"}'
# Returns: { "success": true, "oldLevel": "info", "newLevel": "debug" }

# 3. Get detailed logs with full context
curl "https://snacktrackapi-production.up.railway.app/monitoring/logs?level=error&limit=100"
```

**Log Levels:**
- `error` - Errors only
- `warn` - Warnings and errors
- `info` - Normal operation (default) - clean, scannable logs
- `debug` - Full details - IP addresses, user agents, stack traces, all metadata

#### Long-Term Storage (30+ Days)

**Option 1: Better Stack/Logtail (Recommended)**
```bash
# Set in Railway environment variables
LOGTAIL_TOKEN=your_token_here

# Benefits:
# - 30+ day retention (configurable)
# - Advanced search and filtering
# - Alerts and notifications
# - Free tier: 1GB/month
```

**Option 2: In-Memory Buffer (Recent Logs Only)**
```bash
# Last 1000 logs available via API
curl https://snacktrackapi-production.up.railway.app/monitoring/logs?limit=1000
```

### Log Format

**Info Level (Default) - Clean & Scannable:**
```
20:31:04  GET    200  /health     1ms
20:31:04  POST   400  /auth/register     7ms
20:31:04  ✗  Error occurred  |  method=POST url=/auth/register
```

**Debug Level - Full Details:**
```
20:31:04  GET    200  /health     1ms  |  ip=::ffff:172.18.0.1 ua=curl/8.17.0
20:31:04  ✗  Error occurred  |  method=POST url=/auth/register ip=::ffff:172.18.0.1
  SyntaxError: Unexpected token...
    at JSON.parse (<anonymous>)
    at parse (/usr/src/app/node_modules/body-parser/...)
```

### Helpful Commands

```bash
# Check current log level
curl https://snacktrackapi-production.up.railway.app/monitoring/log-level

# Change to debug (no restart)
curl -X POST https://snacktrackapi-production.up.railway.app/monitoring/log-level \
  -H "Content-Type: application/json" -d '{"level": "debug"}'

# Get recent errors
curl "https://snacktrackapi-production.up.railway.app/monitoring/logs?level=error&limit=50"

# Get logs since specific time
curl "https://snacktrackapi-production.up.railway.app/monitoring/logs?since=2025-11-20T10:00:00Z&limit=100"

# Change back to info
curl -X POST https://snacktrackapi-production.up.railway.app/monitoring/log-level \
  -H "Content-Type: application/json" -d '{"level": "info"}'
```

### Configuration

**Environment Variables:**
```bash
# Log level (default: 'info')
LOG_LEVEL=info

# Better Stack/Logtail token (optional, for long-term storage)
LOGTAIL_TOKEN=your_token_here
```

### Complete Sentry Integration

Sentry is now fully integrated with enhanced features:

**Features:**
- ✅ **Error Tracking** - Automatic 5xx error capture
- ✅ **Performance Monitoring (APM)** - HTTP request tracing, custom transactions
- ✅ **User Context** - Automatic user tracking in error reports
- ✅ **Breadcrumbs** - Request and operation breadcrumbs for debugging
- ✅ **Custom Transactions** - Performance tracking for critical operations
- ✅ **Sensitive Data Filtering** - Automatic password/token removal

**APM Features:**
- HTTP request tracing (10% sampling in prod, 100% in dev)
- Custom transaction tracking
- Performance span measurements
- Database query latency tracking

**Usage in Code:**
```typescript
import { sentryConfig } from './config/sentry';

// Add breadcrumb
sentryConfig.addBreadcrumb('Operation started', 'custom', { data: 'value' });

// Start custom transaction
const transaction = sentryConfig.startTransaction('Import CSV', 'task');
// ... do work ...
transaction?.finish();

// Add performance span
const span = sentryConfig.addSpan('Database Query', 'Query users');
// ... do query ...
span?.finish();
```

### Database Backups

Automated database backup system with retention policy:

**Features:**
- **Automated backups** - Compressed SQL dumps
- **Retention policy** - Keeps last 30 days (configurable)
- **Timestamped files** - Easy to identify backup dates
- **Error handling** - Comprehensive logging and error reporting

**Usage:**
```bash
# Manual backup
./scripts/backup-database.sh

# Automated daily backup (add to crontab)
0 2 * * * /path/to/scripts/backup-database.sh
```

**Configuration (Environment Variables):**
```bash
BACKUP_DIR=./backups          # Backup directory
RETENTION_DAYS=30              # Days to retain backups
DB_HOST=localhost              # Database host
DB_PORT=5432                   # Database port
DB_NAME=snacktrack_dev        # Database name
DB_USER=snacktrack            # Database user
DB_PASSWORD=password           # Database password
```

**Backup Files:**
- Format: `snacktrack_backup_YYYYMMDD_HHMMSS.sql.gz`
- Location: `./backups/` (or `BACKUP_DIR`)
- Logs: `./backups/backup.log`

### Alerting System

Comprehensive alerting system for error rates and performance:

**Features:**
- **Error Rate Monitoring** - Tracks errors per minute
- **Performance Monitoring** - p95 response time tracking
- **Database Health** - Database latency monitoring
- **Automatic Alerts** - Sentry integration for alert notifications
- **Health Status API** - Real-time health status endpoint

**Alert Thresholds (Configurable):**
- Error rate: 10 errors/minute
- Response time: 2000ms p95
- Database latency: 1000ms
- Error count: 50 errors in 5-minute window

**Monitoring Endpoints:**
```bash
# Get system health status (public)
GET /monitoring/health

# Get alert status (public)
GET /monitoring/alerts

# Get current log level (public)
GET /monitoring/log-level

# Change log level dynamically (public, no restart required)
POST /monitoring/log-level
Content-Type: application/json
{ "level": "debug" }

# Get recent logs from in-memory buffer (public)
GET /monitoring/logs?level=error&limit=50&since=2025-11-20T10:00:00Z
```

**Response Example:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "metrics": {
    "errorCount": 2,
    "requestCount": 150,
    "errorRate": 0.4,
    "avgResponseTime": 245,
    "p95ResponseTime": 844
  },
  "thresholds": {
    "errorRate": 10,
    "responseTime": 2000,
    "databaseLatency": 1000,
    "errorCount": 50
  }
}
```

## 🚨 Error Tracking with Sentry (Phase 3 Enhanced)

The API includes **complete Sentry integration** with error tracking and APM:

### Configuration
```bash
# Required for production error tracking and APM
SENTRY_DSN=your_sentry_dsn_here
SENTRY_RELEASE=1.0.0  # Optional: version tracking
```

### Enhanced Features (Phase 3)
- ✅ **Automatic error capture** - All 5xx errors sent to Sentry
- ✅ **Performance Monitoring (APM)** - HTTP request tracing (10% sampling in prod)
- ✅ **User context** - Automatic user tracking in error reports
- ✅ **Breadcrumbs** - Request and operation breadcrumbs for debugging
- ✅ **Custom transactions** - Performance tracking for critical operations
- ✅ **Sensitive data filtering** - Passwords and tokens automatically removed
- ✅ **Free tier compatible** - 5,000 errors/month, 10k transactions/month

### APM Features
- HTTP request tracing with response times
- Custom transaction tracking for background jobs
- Performance span measurements
- Database query latency tracking (via breadcrumbs)

### Usage
- **Development:** Sentry disabled by default (no DSN required)
- **Production:** Set `SENTRY_DSN` environment variable to enable
- **Sampling:** 100% errors, 10% performance in prod (configurable)
- **Upgrade:** Change nothing - scales from free tier to paid seamlessly

### Setup Timing
⚠️ **Set up Sentry BEFORE deploying to production**

1. Create free Sentry account at [sentry.io](https://sentry.io)
2. Create a new project (select Node.js/Express)
3. Copy your DSN
4. Add `SENTRY_DSN` to your production environment variables
5. Deploy - errors and performance data will immediately start being tracked

**Why before deployment?** You want error tracking active from day 1 so you catch any deployment issues immediately.

**Learn more:** [sentry.io](https://sentry.io)

## 🗄️ Database State After Cloning

When you clone this project, you get a **fresh, empty database**:

### 🔄 **Database Persistence:**
- **Data persists** between container restarts (stored in Docker volume)
- **Data is NOT shared** between different machines
- **Perfect for privacy** - each person's data stays on their machine


## 📁 Test Data Structure

The project includes sample Uber CSV data for testing:

```
MockUberData/
└── Uber Data/
    └── Eats/
        ├── user_orders-0.csv      ← Use this file for testing
        └── eats_app_analytics-0.csv
```

**For testing:** Use `MockUberData/Uber Data/Eats/user_orders-0.csv`  
**For your own data:** Replace with your downloaded Uber CSV file


## 🎭 Three Ways to Use It

### Option 1: Uber CSV Import (Recommended)
**Import your complete Uber Eats history**

```bash
# Register a user (requires email and password)
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "YourPass123"}'
# Save the accessToken from response

# Upload your Uber CSV file (example uses the included test data)
curl -X POST http://localhost:3000/csv/import \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -F "csvFile=@MockUberData/Uber Data/Eats/user_orders-0.csv" \
  -F "userId=YOUR_USER_ID"

# Check total spending
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# User summary
curl http://localhost:3000/validation/user/YOUR_USER_ID/summary \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

> **Note:** The example uses the included test CSV file. Replace the file path with your own Uber CSV file when you have it.

### Option 2: Financial Aggregator (Coming Soon)
**Connect bank/credit card accounts**

```bash
# Coming soon: Plaid/TrueLayer integration
# Real-time transaction fetching
# No waiting required
```

### Option 3: Email Parsing (Fallback)
**Use Gmail for receipt parsing**

Use the pre-configured test account `snacktracktest@gmail.com`

1. **Create .env file**
   ```bash
   cat > .env << 'EOF'
   GMAIL_CLIENT_ID=340572988877-8g7j3mqdpa4l69drsjr9r7sscu49j1n7.apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=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
   GMAIL_REDIRECT_URI=http://localhost:3000/auth/callback
   GMAIL_REFRESH_TOKEN=1//05uMl2jXPkTkMCgYIARAAGAUSNwF-L9IrS3JQyKkHDSceLQPRudCJHfd-n3A7lIhT69uKZVbN0dbNIVD2XnXP7vuoTZW7S7qXlxI
   PORT=3000
   NODE_ENV=development
   EOF
   ```

2. **Restart the API**
   ```bash
   docker-compose down && docker-compose up --build -d
   ```

3. **Test with real data**
   ```bash
   # Create user with test Gmail
   curl -X POST http://localhost:3000/users/create \
     -H "Content-Type: application/json" \
     -d '{"email": "snacktracktest@gmail.com"}'
   
   # Update receipts (fetches real emails)
   curl -X POST http://localhost:3000/users/YOUR_USER_ID/update-receipts
   
   # Check spending
   curl http://localhost:3000/users/YOUR_USER_ID/totalSpent
   ```


## 📊 API Endpoints

**Base URL:** `http://localhost:3000`

### 🔐 Authentication Endpoints
- `POST /auth/register` - Register a new user with email and password
- `POST /auth/login` - Login with email and password
- `POST /auth/refresh` - Refresh access token using refresh token
- `POST /auth/logout` - Logout (invalidate refresh token)
- `POST /auth/password/reset/request` - Request password reset code (OTP sent to email)
- `POST /auth/password/reset/verify` - Verify password reset code (validates code)
- `POST /auth/password/reset/complete` - Complete password reset with new password
- `POST /auth/email/verify/send` - Send email verification code
- `POST /auth/email/verify/confirm` - Confirm email verification with code

### 🥡 CSV Import Endpoints
- `POST /csv/import` - Import CSV file directly to database

### 👤 User Management Endpoints
- `POST /users/create` - Create a new user (requires email)
- `GET /users/:id/totalSpent` - Get total spending for user

### 📊 Analytics & Validation Endpoints
- `GET /validation/user/{userId}/summary` - Get comprehensive user analytics and validation

### 🗄️ Database Management Endpoints
- `GET /database/users` - Get all users with statistics
- `GET /database/stats` - Get database statistics and health information
- `DELETE /database/users/{id}` - Delete user and associated receipts

### 🧾 Receipt Endpoints
- `GET /receipts` - Get all receipts with filtering options

### 📊 Monitoring Endpoints
- `GET /monitoring/health` - Get detailed system health status with metrics
- `GET /monitoring/alerts` - Get current alerting status and thresholds

### 🔧 System Endpoints
- `GET /` - Health check
- `GET /health` - Detailed health check with database connectivity

### Example Usage
```bash
# Create user
curl -X POST http://localhost:3000/users/create \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Import Uber CSV (using included test data)
curl -X POST http://localhost:3000/csv/import \
  -F "csvFile=@MockUberData/Uber Data/Eats/user_orders-0.csv" \
  -F "userId=YOUR_USER_ID"

# Get comprehensive summary
curl http://localhost:3000/validation/user/YOUR_USER_ID/summary

# Verify data integrity
curl http://localhost:3000/validation/user/YOUR_USER_ID/verify-csv

# Check database health
curl http://localhost:3000/validation/database/health

# Database management examples
curl http://localhost:3000/database/users
curl http://localhost:3000/database/stats
curl "http://localhost:3000/database/receipts?limit=5"
curl http://localhost:3000/database/receipts/RECEIPT_ID
```

---

## 🛠️ Advanced Setup

### Using Your Own Gmail Account

**Note:** You'll need to add yourself as a test user in the Google Cloud Console.

**Credentials for Google Cloud Console:**
- **Email:** `snacktracktest@gmail.com`
- **Password:** `bluetoastsquares1`

1. **Add Yourself as Test User**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Sign in with the credentials above
   - Go to "APIs & Services" → "OAuth consent screen"
   - Add your Gmail address to "Test users"
   - Save

2. **Get Your Refresh Token**
   - Create `get-token.js` with the script from the [scripts folder](scripts/get-refresh-token.js)
   - Run: `node get-token.js`
   - Follow the OAuth flow
   - Add the refresh token to your `.env` file

3. **Update .env File**
   ```bash
   # Replace the GMAIL_REFRESH_TOKEN with your token
   GMAIL_REFRESH_TOKEN=YOUR_REFRESH_TOKEN_FROM_STEP_2
   ```

### Troubleshooting

- **"Cannot GET /auth/callback"**: Normal during OAuth setup
- **"invalid_client"**: Check your CLIENT_SECRET in .env
- **"Access blocked"**: Add yourself as test user in Google Cloud Console
- **Port 3000 in use**: Stop other services or change port in docker-compose.yml
- **Docker networking issues**: The system uses standard Docker bridge networking and should work on any system with Docker installed

---

## 🤝 Contributing

### Quick Start for Contributors

1. **Fork and clone**
   ```bash
   git clone https://github.com/harry-david-brown/SnackTrackAPI
   cd SnackTrackAPI
   ```

2. **Create feature branch**
   ```bash
   git checkout -b your-feature-name
   ```

3. **Start development**
   ```bash
   docker-compose up --build
   # API available at http://localhost:3000
   # Hot reload enabled - changes auto-restart server
   ```

4. **Test your changes**
   ```bash
   curl http://localhost:3000/
   # Test your specific endpoints
   ```

5. **Commit and push**
   ```bash
   git add .
   git commit -m "Add feature: brief description"
   git push origin your-feature-name
   ```

6. **Create pull request** on GitHub

### Development Tips
- **Hot Reload**: Server restarts automatically on file changes
- **Testing**: Always test with API endpoints before committing
- **Branch Names**: Use descriptive names like `add-outlook-support`
- **Commit Messages**: Be clear about what you changed

---

## 📁 Project Structure

```
snack-track/
├── src/
│   ├── config/                          # Configuration management
│   │   ├── AppConfig.ts                 # Centralized app configuration and environment settings
│   │   ├── ChainConfig.ts               # Restaurant chain consolidation logic
│   │   └── DataSourcePriority.ts        # Data source priority and deduplication rules
│   │
│   ├── models/                          # Data models and interfaces
│   │   ├── AccountType.ts               # User account type enumeration
│   │   ├── CreateUserDTO.ts             # User creation data transfer object
│   │   ├── Email.ts                     # Email model with parsing and filtering logic
│   │   └── Receipt.ts                   # Receipt model with financial breakdown
│   │
│   ├── routes/                          # API route handlers
│   │   ├── csv.ts                       # CSV import/export endpoints
│   │   ├── receipts.ts                  # Receipt management endpoints
│   │   ├── users.ts                     # User management and total spending
│   │   └── validation.ts                # Data validation and health check endpoints
│   │
│   ├── services/                        # Business logic and data access
│   │   ├── core/                        # Core business orchestration
│   │   │   ├── DatabaseService.ts       # Main business logic coordinator
│   │   │   └── ServiceContainer.ts      # Dependency injection container
│   │   │
│   │   ├── data/                        # Data access layer
│   │   │   ├── PostgresService.ts       # Database connection and query execution
│   │   │   ├── ReceiptRepository.ts     # Receipt data access operations
│   │   │   └── UserRepository.ts        # User data access operations
│   │   │
│   │   ├── email/                       # Email processing services
│   │   │   ├── EmailClient.ts           # Email client interface and factory
│   │   │   ├── EmailFilterService.ts    # Email filtering and classification
│   │   │   ├── GmailClient.ts           # Gmail API integration with mock fallback
│   │   │   └── OutlookClient.ts         # Outlook API integration (placeholder)
│   │   │
│   │   ├── import/                      # Data import and source management
│   │   │   ├── CsvImportService.ts      # CSV parsing and import logic
│   │   │   ├── DataSourceManager.ts     # Multi-source data coordination
│   │   │   └── DeduplicationService.ts  # Duplicate detection and resolution
│   │   │
│   │   └── receipt/                     # Receipt processing services
│   │       ├── ReceiptLookupService.ts  # Receipt fetching from various sources
│   │       ├── ReceiptMatcher.ts        # Fuzzy matching for duplicate detection
│   │       ├── ReceiptParserService.ts  # Email-to-receipt parsing logic
│   │       └── ReceiptService.ts        # Receipt business logic and operations
│   │
│   └── index.ts                         # Application entry point and server setup
│
├── MockUberData/                        # Sample data for testing
│   └── Uber Data/
│       └── Eats/
│           └── user_orders-0.csv        # Test CSV file with Uber Eats data
│
├── scripts/                             # Utility scripts
│   ├── get-refresh-token.js             # OAuth token generation helper
│   └── test-config.ts                   # Configuration testing utilities
│
├── docker-compose.yml                   # Development environment setup
├── docker-compose.prod.yml              # Production environment setup
├── Dockerfile                           # Production container configuration
├── Dockerfile.dev                       # Development container configuration
├── package.json                         # Node.js dependencies and scripts
├── tsconfig.json                        # TypeScript configuration
└── README.md                            # Project documentation
```

### 🏗️ Architecture Overview

**Core Services** (`/core`): Main business logic and orchestration
- `DatabaseService`: Coordinates user and receipt operations
- `ServiceContainer`: Manages dependency injection

**Data Services** (`/data`): Data access and persistence
- `PostgresService`: Database connection and query execution
- `UserRepository` & `ReceiptRepository`: Data access operations

**Email Services** (`/email`): Email processing and client management
- `EmailClient`: Interface for different email providers
- `GmailClient`: Gmail API integration with mock data fallback
- `EmailFilterService`: Email classification and filtering

**Import Services** (`/import`): Data import and source management
- `CsvImportService`: CSV parsing and import functionality
- `DataSourceManager`: Multi-source data coordination
- `DeduplicationService`: Duplicate detection and resolution

**Receipt Services** (`/receipt`): Receipt-specific processing
- `ReceiptLookupService`: Fetches receipts from various sources
- `ReceiptParserService`: Converts emails to receipt objects
- `ReceiptMatcher`: Handles fuzzy matching for duplicates
- `ReceiptService`: Receipt business logic and operations

---