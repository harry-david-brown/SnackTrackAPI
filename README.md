# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending by parsing receipt emails from your Gmail account.

## 📋 Project Progress

### Daily Goals (1-3 Day Sprint)
- [x] **Database Setup** - PostgreSQL integration with Docker
- [x] **Receipt CRUD** - Complete receipt management operations
- [x] **Enhanced Email Parsing** - Support more receipt formats
- [x] **Enhanced Receipt** - Improved data structure
- [x] **Spending Analytics** - Average Order Value
- [x] **Smart Email Filtering** - Only query Google for emails from Uber, only store receipts
- [x] **Dev/Prod flag** - Instant switching, collect scattered flags
- [ ] **Duplicate Detection** - Only one receipt per order

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
   ./start.sh
   ```

2. **Test it works**
   ```bash
   curl http://localhost:3000/
   # Should return: ALIVE
   ```

**That's it!** The API is now running on `http://localhost:3000`

## 🎯 What This Does

Snack Track automatically:
- Connects to your Gmail account
- Finds receipt emails from food delivery services (Uber Eats, etc.)
- Extracts spending amounts and restaurant names
- Tracks your total food spending over time
- Provides spending analytics and insights

## 🎭 Two Ways to Use It

### Option 1: Demo Mode (Easiest)
**Perfect for trying it out - uses fake data**

```bash
# Create a demo user
curl -X POST http://localhost:3000/users/create \
  -H "Content-Type: application/json" \
  -d '{"email": "demo@example.com"}'

# Copy the user ID from response, then:
curl -X POST http://localhost:3000/users/YOUR_USER_ID/update-receipts

# Check total spending
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent
```

### Option 2: Real Gmail Data
**Track your actual food spending**

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

### Essential Endpoints
- `GET /` - Health check (returns "ALIVE")
- `POST /users/create` - Create a new user
- `GET /users/:id/totalSpent` - Get total spending
- `POST /users/:id/update-receipts` - Fetch and parse emails
- `GET /users/:id/debug/emails` - See raw email data
- `GET /receipts/analytics/:userId` - Get spending analytics

### Example Usage
```bash
# Create user
curl -X POST http://localhost:3000/users/create \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com"}'

# Get total spent
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent

# Get analytics
curl http://localhost:3000/receipts/analytics/YOUR_USER_ID
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