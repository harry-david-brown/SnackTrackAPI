const { google } = require('googleapis');
const readline = require('readline');

// Replace these with your actual credentials from Google Cloud Console
const CLIENT_ID = 'your_client_id_here';
const CLIENT_SECRET = 'your_client_secret_here';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate the URL for OAuth consent
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

console.log('🔗 Open this URL in your browser:');
console.log(authUrl);
console.log('\n📋 After authorization, you\'ll get a code. Paste it here:');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Enter the authorization code: ', async (code) => {
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('\n✅ Success! Add these to your .env file:');
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REDIRECT_URI=${REDIRECT_URI}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n🎉 You can now use real Gmail data!');
  } catch (error) {
    console.error('❌ Error getting token:', error.message);
  }
  rl.close();
});
