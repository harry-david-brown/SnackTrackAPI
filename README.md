# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending through multiple data sources: **Uber CSV imports**, **financial aggregators (Plaid/TrueLayer)**, and **email parsing** as a fallback.

## 📋 Project Progress

### ✅ Core Features Complete
- [x] **Database Setup** - PostgreSQL integration with Docker
- [x] **Receipt Management** - Complete CRUD operations
- [x] **CSV/ZIP Import** - Parse and import Uber Eats data
- [x] **Spending Analytics** - Comprehensive user summaries and insights
- [x] **Wrapped Analytics** - Spotify-style shareable insights (13 viral categories)
- [x] **Email Integration** - Parse receipts from Gmail (now with OAuth connection!)
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
- [x] **Alerting** - Error rate and performance alerts with health monitoring
- [x] **Database Optimizations** - GIN index on JSONB items, year column for partitioning
- [x] **Load Balancing Support** - Stateless design, shared Redis cache, graceful shutdown, health checks
- [x] **Pagination for receipts (Doesn't do anything right now, future feature)** - Handle large datasets efficiently

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

**All examples below use `http://localhost:3000` for local development.**

### Prerequisites
- Docker and Docker Compose
- Git

### 1. Clone and Start
```bash
git clone https://github.com/harry-david-brown/SnackTrackAPI
cd SnackTrackAPI
docker-compose up --build -d
```

This automatically sets up:
- **Local PostgreSQL** database (no Railway connection needed)
- **Local Redis** cache (no Railway connection needed)
- **Server on `http://localhost:3000`** (development mode)

**Note:** The service runs completely locally by default. It will NOT connect to Railway production services unless you explicitly configure environment variables to do so.

### 2. Verify It's Running
```bash
curl http://localhost:3000/
# Should return: ALIVE
```

**That's it!** The API is now running on `http://localhost:3000`

### 3. Create Your First User
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "SecurePass123"}'
```

**Response:**
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "...", "email": "user@example.com" }
}
```

**Save the `accessToken` and `userId`** - you'll need them for authenticated requests.

### 4. Import Your Data
```bash
# Upload Uber Eats CSV file
curl -X POST http://localhost:3000/csv/import \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -F "csvFile=@path/to/your/uber-data.csv" \
  -F "userId=YOUR_USER_ID"
```

### 5. View Your Analytics
```bash
# Get spending summary
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get comprehensive analytics
curl http://localhost:3000/users/YOUR_USER_ID/summary \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get wrapped analytics (viral insights)
curl "http://localhost:3000/users/YOUR_USER_ID/summary?includeWrapped=true" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## 🔐 Authentication

All user-specific endpoints require JWT authentication.

### Password Requirements
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 number

### Token Management
- **Access Token:** Expires in 15 minutes
- **Refresh Token:** Expires in 7 days
- Use `/auth/refresh` to get new tokens before expiry

### Quick Auth Flow
```bash
# 1. Register
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "SecurePass123"}'

# 2. Login (if already registered)
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "SecurePass123"}'

# 3. Use token in requests
curl -X GET http://localhost:3000/users/{userId}/totalSpent \
  -H "Authorization: Bearer {accessToken}"

# 4. Refresh token when needed
curl -X POST http://localhost:3000/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

### Password Reset
```bash
# Request reset code
curl -X POST http://localhost:3000/auth/password/reset/request \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Complete reset
curl -X POST http://localhost:3000/auth/password/reset/complete \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "code": "123456", "newPassword": "NewPass123"}'
```

### Email Verification
```bash
# Send verification code
curl -X POST http://localhost:3000/auth/email/verify/send \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Confirm verification
curl -X POST http://localhost:3000/auth/email/verify/confirm \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "code": "123456"}'
```

**Note:** OTP codes expire in 15 minutes. Rate limiting applies.

---

## 📚 API Reference

**Base URL:** `http://localhost:3000` (local) | `https://snacktrackapi-production.up.railway.app` (production)

### Authentication
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login with email/password
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout (invalidate refresh token)
- `POST /auth/password/reset/request` - Request password reset code
- `POST /auth/password/reset/verify` - Verify reset code
- `POST /auth/password/reset/complete` - Complete password reset
- `POST /auth/email/verify/send` - Send email verification code
- `POST /auth/email/verify/confirm` - Confirm email verification

### Data Import
#### CSV/ZIP Upload
- `POST /csv/import` - Import Uber Eats CSV/ZIP file
  - **Requires:** `Authorization: Bearer {token}`
  - Form data: `csvFile` (file), `userId` (string)

#### Gmail Integration (NEW! 🎉)
**Connection Flow:**
- `POST /gmail/exchange-token` - Store a Google-issued Gmail token after frontend OAuth
  - **Requires:** `Authorization: Bearer {token}`
  - Body: `{"accessToken": string, "refreshToken"?: string}`

**Import & Management:**
- `GET /gmail/status` - Check Gmail connection status
  - **Requires:** `Authorization: Bearer {token}`
  - Returns connection mode and import readiness state
- `GET /gmail/import/status` - Check whether an import is already in progress
  - **Requires:** `Authorization: Bearer {token}`
- `POST /gmail/import` - Import Uber Eats receipts from Gmail
  - **Requires:** `Authorization: Bearer {token}`
- `POST /gmail/disconnect` - Disconnect Gmail account
  - **Requires:** `Authorization: Bearer {token}`

Setup docs:
- [GMAIL_INTEGRATION.md](./GMAIL_INTEGRATION.md)
- [docs/GMAIL_OAUTH_SETUP.md](./docs/GMAIL_OAUTH_SETUP.md)

### Users
- `GET /users/:id/totalSpent` - Get total spending for user
  - **Requires:** `Authorization: Bearer {token}`
  - Users can only access their own data
- `GET /users/:id/summary` - Comprehensive user analytics
  - **Requires:** `Authorization: Bearer {token}`
  - Query params: `includeWrapped=true` (optional, adds viral insights)
  - Users can only access their own data

### Receipts
- `GET /receipts?userId={userId}` - Get receipts with pagination and filtering
  - **Requires:** `Authorization: Bearer {token}`
  - **Required:** `userId` query parameter (must match authenticated user)
  - Query params: `page`, `limit`, `startDate`, `endDate`, `restaurantName`, `minAmount`, `maxAmount`
  - Users can only query their own receipts

### Database (Admin - API Key Required)
- `GET /database/users` - List all users with statistics
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /database/stats` - Database statistics and health
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `DELETE /database/users/:id` - Delete user and all receipts
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter

### Monitoring
**Public Endpoints (No Authentication):**
- `GET /monitoring/health` - System health with metrics
- `GET /monitoring/alerts` - Alert status

**Admin Endpoints (API Key Required):**
- `GET /monitoring/log-level` - Get current log level
- `POST /monitoring/log-level` - Change log level dynamically
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /monitoring/logs` - Get recent logs from in-memory buffer
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /monitoring/cache` - Redis cache statistics
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /monitoring/test-sentry` - Test Sentry error capture
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /monitoring/database-optimizations` - Database optimization status
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter
- `GET /monitoring/query-performance` - Query performance analysis
  - **Requires:** `X-API-Key: {apiKey}` header or `?apiKey={apiKey}` query parameter

### System
- `GET /` - Basic health check (returns "ALIVE")
- `GET /health` - Detailed health check with database status

### API Documentation
- Swagger UI available at `/docs` (when running locally)

### Security Notes
- **JWT Authentication:** Required for all user-specific endpoints. Get token via `/auth/login` or `/auth/register`
- **API Key Authentication:** Required for admin endpoints (database, monitoring). Set `API_KEY` environment variable in production
- **Ownership Validation:** Users can only access their own data (enforced automatically)

---

## 🛠️ Development Guide

### For New Developers

#### Project Structure
```
src/
├── config/          # Configuration (database, Redis, Sentry, etc.)
├── models/         # Data models and TypeScript interfaces
├── routes/         # API route handlers
├── services/       # Business logic
│   ├── core/       # Core services (cache, container)
│   ├── data/       # Database access (PostgresService, repositories)
│   ├── email/      # Email processing (Gmail, Outlook)
│   ├── import/     # CSV import and data source management
│   └── receipt/    # Receipt processing logic
└── middleware/     # Express middleware (auth, pagination, error handling)
```

#### Key Files
- `src/index.ts` - Application entry point, server setup
- `src/services/data/PostgresService.ts` - Database connection and queries
- `src/services/core/CacheService.ts` - Redis caching
- `src/middleware/auth.ts` - JWT authentication middleware
- `src/routes/` - All API endpoints organized by feature

#### Running Locally
```bash
# Start all services (PostgreSQL, Redis, API)
docker-compose up --build -d

# View logs
docker-compose logs -f snack-track-api

# Stop services
docker-compose down

# Rebuild after dependency changes
docker-compose up --build -d
```

#### Development Workflow
1. **Make changes** to TypeScript files in `src/`
2. **Server auto-restarts** (hot reload enabled)
3. **Test endpoints** with curl or Postman
4. **Check logs** in terminal or Railway dashboard

#### Testing
```bash
# Run test suites
cd tests
./test-full-suite.sh           # Complete test suite
./test-auth-comprehensive.sh   # Authentication tests
./test-pagination.sh           # Pagination tests
./test-load-balancing.sh       # Load balancing tests
```

#### Building for Production
```bash
# Compile TypeScript
npm run build

# Test production build locally
npm start
```

---

## 🔧 Configuration

### Environment Variables

**Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT token signing

**Optional:**
- `REDIS_URL` - Redis connection string (enables caching)
- `SENTRY_DSN` - Sentry error tracking (production)
- `LOG_LEVEL` - Logging level (`error`, `warn`, `info`, `debug`)
- `LOGTAIL_TOKEN` - Better Stack/Logtail token (long-term log storage)
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (`development` or `production`)

### Docker Compose Setup
The `docker-compose.yml` file includes:
- **PostgreSQL** - Database service
- **Redis** - Cache service
- **API** - Main application service

All services are pre-configured and start automatically.

### Local vs Production

**Local Development (Default):**
- Running `docker-compose up` uses **local** PostgreSQL and Redis containers
- Perfect for development and testing
- No Railway connection needed

**Railway Production (Automatic):**
- When you **push code to Railway**, it automatically deploys
- Railway uses its own environment variables (set in Railway dashboard)
- No code changes needed - Railway handles production configuration automatically

**Optional: Local Development with Railway Services**
If you want to run locally but connect to Railway's production database/Redis (not recommended for most cases):
1. Create a `.env` file with Railway credentials
2. Comment out the `environment:` section in `docker-compose.yml` (lines 11-13)
3. Restart: `docker-compose up --build -d snack-track-api`

---

## 📊 Monitoring & Operations

### Logging

**View Logs:**
```bash
# Local development (replace with production URL for production)
# Requires API key for admin endpoints
curl -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/monitoring/logs

# Filter by level
curl -H "X-API-Key: YOUR_API_KEY" "http://localhost:3000/monitoring/logs?level=error&limit=50"
```

**Change Log Level (No Restart Required):**
```bash
# Check current level (public endpoint)
curl http://localhost:3000/monitoring/log-level

# Switch to debug mode (requires API key)
curl -X POST http://localhost:3000/monitoring/log-level \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"level": "debug"}'
```

**Note:** For production, replace `http://localhost:3000` with your production URL.

**Log Levels:**
- `error` - Errors only
- `warn` - Warnings and errors
- `info` - Normal operation (default)
- `debug` - Full details with stack traces

### Error Tracking (Sentry)

**Setup:**
1. Create account at [sentry.io](https://sentry.io)
2. Create Node.js/Express project
3. Copy DSN
4. Set `SENTRY_DSN` environment variable
5. Deploy - errors automatically tracked

**Features:**
- Automatic error capture (5xx errors)
- Performance monitoring (APM)
- User context tracking
- Breadcrumbs for debugging

### Health Monitoring

```bash
# System health (public endpoint)
GET /monitoring/health

# Alert status (public endpoint)
GET /monitoring/alerts

# Cache status (requires API key)
GET /monitoring/cache
# Header: X-API-Key: YOUR_API_KEY
```

---

## 🗄️ Database

### Schema
- **users** - User accounts
- **receipts** - Food delivery receipts
- **verification_codes** - Email/password reset codes

### Optimizations
- GIN index on JSONB items column
- Partial indexes for common queries
- Year column for future partitioning
- Connection pooling (20 connections in prod)

### Backups
```bash
# Manual backup
./scripts/backup-database.sh

# Automated (add to crontab)
0 2 * * * /path/to/scripts/backup-database.sh
```

---

## 🧪 Testing

### Test Suites
- `tests/test-full-suite.sh` - Complete integration tests
- `tests/test-auth-comprehensive.sh` - Authentication flow
- `tests/test-pagination.sh` - Pagination functionality
- `tests/test-load-balancing.sh` - Multi-instance readiness
- `tests/load-test-realistic.sh` - Load testing (50 users, 1000 requests)

### Running Tests
```bash
cd tests
./test-full-suite.sh
```

---

## 🚀 Deployment

### Railway Production (Automatic)

**How it works:**
1. Push code to your repository
2. Railway automatically detects the push and deploys
3. Railway uses environment variables configured in the Railway dashboard
4. No code changes needed - production configuration is automatic

### Production Environment
- **Platform:** Railway (validated)
- **Database:** PostgreSQL (Railway managed)
- **Cache:** Redis (Railway managed)
- **Monitoring:** Sentry APM

### Railway Environment Variables
Configure these in the Railway dashboard:
- `NODE_ENV=production` (usually set automatically)
- `DATABASE_URL` - Railway PostgreSQL connection string (auto-provided)
- `JWT_SECRET` - Secret key for JWT tokens
- `API_KEY` - API key for admin endpoints (database, monitoring) - **Required for production security**
- `SENTRY_DSN` - Sentry error tracking (recommended)
- `REDIS_URL` - Railway Redis connection string (auto-provided if Redis service added)

### Deployment Checklist
- [ ] Configure environment variables in Railway dashboard
- [ ] Verify health checks: `curl https://your-app.railway.app/health`
- [ ] Monitor logs in Railway dashboard

---

## 📁 Project Structure

```
snack-track/
├── src/
│   ├── config/          # App configuration, Redis, Sentry, logger
│   ├── models/          # TypeScript interfaces and types
│   ├── routes/          # API route handlers
│   ├── services/        # Business logic
│   │   ├── core/        # Cache, service container
│   │   ├── data/        # Database access layer
│   │   ├── email/       # Email processing
│   │   ├── import/      # CSV import services
│   │   └── receipt/      # Receipt processing
│   ├── middleware/      # Auth, pagination, error handling
│   └── index.ts         # Application entry point
├── tests/               # Test suites
├── scripts/             # Utility scripts
├── MockUberData/        # Sample test data
├── docker-compose.yml   # Development environment
└── README.md
```

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly
5. Commit with clear messages
6. Push and create a pull request

### Development Tips
- Hot reload is enabled - changes auto-restart server
- Always test endpoints before committing
- Follow existing code patterns
- Update tests for new features

---

## 📝 License

MIT License
