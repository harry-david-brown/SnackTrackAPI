# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending through multiple data sources: **Uber CSV imports**, **financial aggregators (Plaid/TrueLayer)**, and **email parsing** as a fallback.

## 📋 Project Progress

### Daily Goals (1-3 Day Sprint)
- [x] **Database Setup** - PostgreSQL integration with Docker
- [x] **Receipt CRUD** - Complete receipt management operations
- [x] **CSV File Parsing** - Parse Uber CSV data and extract order information
- [x] **CSV Data Import** - Import parsed CSV data into PostgreSQL database
- [x] **CSV API Endpoints** - Upload, preview, import, and status endpoints
- [x] **CSV Data Validation** - Comprehensive data integrity verification
- [x] **CSV User Management** - Create users specifically for CSV imports
- [x] **Spending Analytics** - Average Order Value and detailed insights
- [x] **Smart Email Filtering** - Only query Google for emails from Uber, only store receipts
- [x] **Dev/Prod flag** - Instant switching, collect scattered flags
- [x] **Restaurant Chain Consolidation** - Group spending across multiple locations of major chains
- [x] **Deduplication Scaffolding** - Abstract system for handling multiple data sources
- [x] **Refactoring** - Project restructuring, decoupling, dependency injection, separation of concerns
- [x] **Database Management API** - Complete database viewing and management endpoints
- [ ] **Financial Aggregator Integration** - Plaid/TrueLayer API integration

### Weekly Goals (1-2 Week Sprint)
- [ ] **Complete API MVP** - Production-ready backend
- [ ] **Frontend Planning** - Choose React Native vs. Expo
- [ ] **Design System** - Create basic UI/UX mockups
- [ ] **Testing Setup** - Add comprehensive tests
- [ ] **Deployment** - Set up production deployment

### Monthly Goals (3-4 Week Sprint)
- [ ] **Complete Frontend** - Full React Native app
- [ ] **Integration** - Connect frontend to API
- [ ] **Android Testing** - Test on emulator and device
- [ ] **User Testing** - Get feedback from friends
- [ ] **Polish** - UI/UX improvements and bug fixes

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
# Create a CSV-only user (no email required)
curl -X POST http://localhost:3000/users/create-csv

# Upload your Uber CSV file (example uses the included test data)
curl -X POST http://localhost:3000/csv/import \
  -F "csvFile=@MockUberData/Uber Data/Eats/user_orders-0.csv" \
  -F "userId=YOUR_USER_ID"

# Check total spending
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent

# User summary
curl http://localhost:3000/validation/user/YOUR_USER_ID/summary
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
- `POST /csv/upload` - Upload and parse CSV file
- `POST /csv/preview` - Preview CSV data without importing
- `POST /csv/import` - Import CSV data to database
- `GET /csv/status/:userId` - Get import status for user

### 📊 Validation & Analytics Endpoints
- `GET /validation/user/:userId/summary` - Complete user data summary
- `GET /validation/user/:userId/receipts` - Detailed receipt breakdown
- `GET /validation/user/:userId/verify-csv` - CSV data integrity verification
- `GET /validation/database/health` - Database health and statistics

### 👤 User Management Endpoints
- `POST /users/create` - Create a new user (requires email)
- `POST /users/create-csv` - Create a CSV-only user (no email required)
- `GET /users/:id/totalSpent` - Get total spending
- `GET /receipts/analytics/:userId` - Get spending analytics

### 📧 Email Endpoints (Fallback)
- `POST /users/:id/update-receipts` - Fetch and parse emails
- `GET /users/:id/debug/emails` - See raw email data

### 🗄️ Database Management Endpoints
- `GET /database/users` - View all users with statistics
- `GET /database/users/:id` - View specific user with all receipts
- `GET /database/receipts` - View all receipts with filtering and pagination
- `GET /database/receipts/:id` - View specific receipt details
- `GET /database/stats` - Comprehensive database analytics
- `DELETE /database/users/:id` - Delete user and all receipts (optional)
- `DELETE /database/receipts/:id` - Delete specific receipt (optional)

### Example Usage
```bash
# Create CSV-only user
curl -X POST http://localhost:3000/users/create-csv

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
│   │   └── DataSourcePriority.ts       # Data source priority and deduplication rules
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
│   │   ├── users.ts                     # User management and spending analytics
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