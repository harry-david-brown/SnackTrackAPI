# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending through multiple data sources: **Uber CSV imports**, **financial aggregators (Plaid/TrueLayer)**, and **email parsing** as a fallback.

## 📋 Project Progress

### ✅ Core Features Complete
- [x] **Database Setup** - PostgreSQL integration with Docker
- [x] **Receipt Management** - Complete CRUD operations
- [x] **CSV/ZIP Import** - Parse and import Uber Eats data
- [x] **Spending Analytics** - Comprehensive user summaries and insights
- [x] **Email Integration** - Parse receipts from Gmail
- [x] **Restaurant Chain Consolidation** - Smart grouping across locations
- [x] **JWT Authentication** - Secure user authentication and authorization
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
- [x] **Load Testing** - ✅ Validated 1000+ concurrent users (p95: 629ms, p99: 664ms)

#### Wrapped Analytics Feature (Week 5)
- [ ] **Shame Analytics** - 3am orders, lazy days, order streaks, chain dependency
- [ ] **Flex Analytics** - Most expensive order, coffee addiction, night owl stats
- [ ] **Comparative Analytics** - Investment calculator, cost equivalents
- [ ] **Pattern Analytics** - Peak hours, weekend patterns, delivery times
- [ ] **API Expansion** - Add wrapped analytics to summary endpoint

#### Phase 3: Monitoring & Operations (Week 6)
- [ ] **Structured Logging** - Winston with log aggregation
- [ ] **APM Integration** - Application performance monitoring
- [ ] **Database Backups** - Automated daily backups
- [ ] **Alerting** - Error rate and performance alerts

#### Phase 4: Scale Preparation (Weeks 7-8)
- [ ] **Async Job Queue** - Background CSV processing
- [ ] **API Versioning** - /v1 prefix for all routes
- [ ] **Pagination** - Handle large datasets efficiently
- [ ] **Load Balancing** - Multi-instance support

### 📊 Current Status
**Timeline:** Phase 1 ✅ | Phase 2 ✅ | MVP Production-Ready! 🚀  
**Load Tested:** 100% success (sustained: 50 users, spike: 1000 users)  
**Performance:** p95: 630ms, p99: 648ms, 36.8% faster with Redis  
**Throughput:** 125 req/s, production rate limits enabled  
**Deployment:** Validated for Railway/Render (500-1000+ users)  
**Next Feature:** Wrapped Analytics (Spotify-style shareable insights)

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

**See `FRONTEND_UPDATES.md` for complete integration guide.**

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

## 🚨 Error Tracking with Sentry

The API includes Sentry integration for production error monitoring:

### Configuration
```bash
# Optional - only needed for production error tracking
SENTRY_DSN=your_sentry_dsn_here
```

### Features
- **Automatic error capture** - All 5xx errors sent to Sentry
- **User context** - Errors include user ID and email for debugging
- **Sensitive data filtering** - Passwords and tokens automatically removed
- **Performance monitoring** - Track slow endpoints and database queries
- **Free tier compatible** - 5,000 errors/month, easy upgrade path

### Usage
- **Development:** Sentry disabled by default (no DSN required)
- **Production:** Set `SENTRY_DSN` environment variable to enable
- **Upgrade:** Change nothing - scales from free tier to paid seamlessly

### Setup Timing
⚠️ **Set up Sentry BEFORE deploying to production**

1. Create free Sentry account at [sentry.io](https://sentry.io)
2. Create a new project (select Node.js/Express)
3. Copy your DSN
4. Add `SENTRY_DSN` to your production environment variables
5. Deploy - errors will immediately start being tracked

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

### 🔧 System Endpoints
- `GET /` - Health check

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