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

> **Note:** The system uses standard Docker bridge networking and should work out-of-the-box on any system with Docker installed.

## 🗄️ Database State After Cloning

When you clone this project, you get a **fresh, empty database**:

### ✅ **What You Get:**
- **Empty database schema** (tables created automatically)
- **All the code** (CSV import functionality ready to use)
- **Docker setup** (ready to run immediately)
- **Test CSV file** (`MockUberData/Uber Data/Eats/user_orders-0.csv`)

### ❌ **What You DON'T Get:**
- **No users** (database starts completely empty)
- **No receipts** (no imported data)
- **No personal data** (each person gets their own clean slate)

### 🔄 **Database Persistence:**
- **Data persists** between container restarts (stored in Docker volume)
- **Data is NOT shared** between different machines
- **Perfect for privacy** - each person's data stays on their machine

### 🎯 **Perfect Setup:**
This clean slate approach is ideal because:
1. **No conflicts** - no mixing of different people's data
2. **Privacy** - each person's data stays on their machine
3. **Easy setup** - just clone, run Docker, and import your own CSV
4. **Fresh start** - everyone gets the same clean experience

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

## 🎯 What This Does

Snack Track automatically tracks your food spending through multiple data sources:

### 🥡 **Primary Method: Uber CSV Import**
- Import your complete Uber Eats order history (6+ years of data!)
- Download your data from Uber's privacy portal
- Upload CSV file for instant analysis
- **Most comprehensive** - includes every order ever made

### 💳 **Secondary Method: Financial Aggregators**
- Connect bank/credit card accounts via Plaid/TrueLayer
- Real-time transaction fetching
- **Quickest option** - no waiting required
- Limited to last 1-2 years of transactions

### 📧 **Fallback Method: Email Parsing**
- Connects to your Gmail account
- Finds receipt emails from food delivery services
- **Backup option** - when other methods aren't available

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

# Verify data integrity
curl http://localhost:3000/validation/user/YOUR_USER_ID/verify-csv
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

**Easiest:** Use the pre-configured test account `snacktracktest@gmail.com`

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

## 🔧 Configuration

The system automatically works in **development mode** (most plug-and-play):
- Uses mock data when no Gmail credentials are provided
- Uses real Gmail API when credentials are present
- Includes helpful debug information
- No SSL requirements for local database

**To switch to production mode:**
```bash
# Change NODE_ENV in .env file
NODE_ENV=production

# Restart the server
docker-compose down && docker-compose up --build -d
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