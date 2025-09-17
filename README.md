# 🥡 Snack Track API

A Node.js/TypeScript API that automatically tracks your food spending by parsing receipt emails from your Gmail account.

## 🚀 Installation

**Prerequisites:** Docker and Docker Compose must be installed

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd snack-track
   ```

2. **Run the startup script**
   ```bash
   ./start.sh
   ```

3. **Test it works**
   ```bash
   curl http://localhost:3000/
   # Should return: ALIVE
   ```

**That's it!** The API is now running on `http://localhost:3000`

## 🎭 Option 1: Demo Mode (Mock Data)

**Use this if you just want to see how it works without any setup.**

The API automatically uses mock data when no Gmail credentials are provided. You'll see fake receipt data from Starbucks, McDonald's, and Chipotle.

**Test the demo:**
```bash
# Create a user
curl -X POST http://localhost:3000/users/create \
  -H "Content-Type: application/json" \
  -d '{"email": "demo@example.com"}'

# Copy the user ID from the response, then:
curl -X POST http://localhost:3000/users/YOUR_USER_ID/update-receipts

# Check total spending
curl http://localhost:3000/users/YOUR_USER_ID/totalSpent
```

## 📧 Option 2: Real Gmail Data

**Use this to track your actual food spending from your Gmail account.**

### Quick Setup (Using Test Account)

**Easiest option:** Use the pre-configured test account `snacktracktest@gmail.com` (password: `bluetoastsquares1`)

1. **Create .env file**
   ```bash
   cat > .env << 'EOF'
   GMAIL_CLIENT_ID=340572988877-8g7j3mqdpa4l69drsjr9r7sscu49j1n7.apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=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
   GMAIL_REDIRECT_URI=http://localhost:3000/auth/callback
   GMAIL_REFRESH_TOKEN=1//05uMl2jXPkTkMCgYIARAAGAUSNwF-L9IrS3JQyKkHDSceLQPRudCJHfd-n3A7lIhT69uKZVbN0dbNIVD2XnXP7vuoTZW7S7qXlxI
   PORT=3000
   NODE_ENV=production
   EOF
   ```

2. **Restart the API**
   ```bash
   docker-compose -f docker-compose.prod.yml down
   docker-compose -f docker-compose.prod.yml up --build
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

### Setup Your Own Gmail (Advanced)

**Only do this if you want to use your own Gmail account instead of the test account.**

**Important:** You'll need to add yourself as a test user in the Google Cloud Console. Use these credentials to access it:

- **Email:** `snacktracktest@gmail.com`
- **Password:** `bluetoastsquares1`

1. **Add Yourself as Test User**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Sign in with `snacktracktest@gmail.com` / `bluetoastsquares1`
   - Go to "APIs & Services" → "OAuth consent screen"
   - Scroll down to "Test users" section
   - Click "Add users" and add your Gmail address
   - Click "Save"

2. **Get Your Refresh Token**
   - Create a file called `get-token.js` with this content:
   ```javascript
   const { google } = require('googleapis');
   const readline = require('readline');
   
   const CLIENT_ID = '340572988877-8g7j3mqdpa4l69drsjr9r7sscu49j1n7.apps.googleusercontent.com';
   const CLIENT_SECRET = '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';
   const REDIRECT_URI = 'http://localhost:3000/auth/callback';
   
   const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
   const authUrl = oAuth2Client.generateAuthUrl({
     access_type: 'offline',
     scope: ['https://www.googleapis.com/auth/gmail.readonly'],
   });
   
   console.log('Open this URL:', authUrl);
   console.log('After authorization, copy the code from the URL and paste it here:');
   
   const rl = readline.createInterface({
     input: process.stdin,
     output: process.stdout,
   });
   
   rl.question('Enter the authorization code: ', async (code) => {
     const { tokens } = await oAuth2Client.getToken(code);
     console.log('Add this to your .env file:');
     console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
     rl.close();
   });
   ```
   - Run: `node get-token.js`
   - Follow the OAuth flow
   - Add the refresh token to your `.env` file

3. **Create Your .env File**
   ```bash
   cat > .env << 'EOF'
   GMAIL_CLIENT_ID=340572988877-8g7j3mqdpa4l69drsjr9r7sscu49j1n7.apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=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
   GMAIL_REDIRECT_URI=http://localhost:3000/auth/callback
   GMAIL_REFRESH_TOKEN=YOUR_REFRESH_TOKEN_FROM_STEP_2
   PORT=3000
   NODE_ENV=production
   EOF
   ```

4. **Restart the API**
   ```bash
   docker-compose -f docker-compose.prod.yml down
   docker-compose -f docker-compose.prod.yml up --build
   ```

---

## 📚 Additional Information

### API Endpoints

- `POST /users/create` - Create a user
- `POST /users/:id/update-receipts` - Fetch emails and parse receipts
- `GET /users/:id/totalSpent` - Get total spending
- `GET /users/:id/debug/emails` - See raw email data

### How It Works

1. Creates a user with your Gmail address
2. Connects to Gmail API to fetch inbox emails
3. Extracts dollar amounts and items from email text
4. Stores parsed receipts in memory
5. Calculates total spending

### Docker Commands

```bash
# Start the API
./start.sh

# Stop the API
docker-compose -f docker-compose.prod.yml down

# View logs
docker-compose -f docker-compose.prod.yml logs -f
```

### Troubleshooting

- **"Cannot GET /auth/callback"**: This is normal during OAuth setup
- **"invalid_client"**: Check your CLIENT_SECRET in the .env file
- **"Access blocked"**: Add yourself as a test user in Google Cloud Console
- **Port 3000 in use**: Stop other services or change the port in docker-compose.prod.yml

---

## 🤝 Contributing

### For Contributors

**Prerequisites:** Docker, Docker Compose, and Git installed

### 1. Fork and Clone
```bash
# Fork the repository on GitHub first, then:
git clone https://github.com/harry-david-brown/SnackTrackAPI
cd SnackTrackAPI
```

### 2. Create a Feature Branch
```bash
# Always create a new branch for your changes
git checkout -b your-feature-name
# Example: git checkout -b add-outlook-support
```

### 3. Development Setup
```bash
# Start the API in development mode (with hot reload)
docker-compose up --build

# The API will be available at http://localhost:3000
# Changes to your code will automatically restart the server
```

### 4. Make Your Changes
- Edit files in the `src/` directory
- The server will automatically restart when you save changes
- Test your changes with the API endpoints

### 5. Test Your Changes
```bash
# Test the API is working
curl http://localhost:3000/

# Test your specific changes
curl -X POST http://localhost:3000/users/create \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
```

### 6. Stop Development Server
```bash
# Stop the development server when done
docker-compose down
```

### 7. Commit and Push
```bash
# Add your changes
git add .

# Commit with a descriptive message
git commit -m "Add feature: brief description of what you did"

# Push to your fork
git push origin your-feature-name
```

### 8. Create Pull Request
- Go to your fork on GitHub
- Click "New Pull Request"
- Select your feature branch
- Write a description of your changes
- Submit the pull request

### Development Tips

**Hot Reload:** The development server automatically restarts when you change files, so you can see changes immediately.

**Testing:** Always test your changes before committing. Use the API endpoints to verify everything works.

**Branch Names:** Use descriptive names like `add-outlook-support`, `fix-email-parsing`, `improve-docker-setup`.

**Commit Messages:** Be clear about what you changed, like "Fix email parsing for McDonald's receipts" or "Add error handling for Gmail API".

### For Maintainers

**Reviewing Pull Requests:**
1. Check the code changes
2. Test the changes locally:
   ```bash
   # Pull their branch
   git fetch origin
   git checkout their-feature-branch
   
   # Test with development mode
   docker-compose up --build
   
   # Test the changes
   curl http://localhost:3000/
   ```
3. If everything looks good, merge the pull request
4. Delete the feature branch after merging

**Managing the Repository:**
- Keep the `main` branch stable
- Review all pull requests before merging
- Test changes before accepting them
- Update the README if needed

---