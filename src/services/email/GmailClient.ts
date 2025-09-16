import { User } from '../../models/User';
import { Email } from '../../models/Email';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// Utility for base64 decoding (Gmail uses URL-safe base64)
function decodeBase64Gmail(str: string): string {
  const decoded = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return decoded;
}

export class GmailClient {
  async getEmails(user: User): Promise<Email[]> {
    // For quick testing - replace with your actual credentials
    const CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'your_client_id_here';
    const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'your_client_secret_here';
    const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/callback';
    const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || 'your_refresh_token_here';

    // Quick validation
    if (CLIENT_ID === 'your_client_id_here' || REFRESH_TOKEN === 'your_refresh_token_here') {
      console.log('⚠️  Gmail credentials not configured. Using mock data for testing.');
      return this.getMockEmails(user);
    }

    const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const emailList: Email[] = [];

    try {
      // Fetch list of messages in the inbox
      const listRes = await gmail.users.messages.list({
        userId: 'me', // Use 'me' for the authenticated user
        labelIds: ['INBOX'],
        maxResults: 5, // Limit for testing
      });

      if (listRes.data.messages) {
        for (const msg of listRes.data.messages) {
          // Fetch the full message
          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
          });
          const payload = msgRes.data.payload;
          let from = '', to = '', body = '';
          if (payload && payload.headers) {
            for (const header of payload.headers) {
              if (header.name === 'From') from = header.value || '';
              if (header.name === 'To') to = header.value || '';
            }
          }
          // Get the body (handle multipart)
          if (payload?.body?.data) {
            body = decodeBase64Gmail(payload.body.data);
          } else if (payload?.parts) {
            for (const part of payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body = decodeBase64Gmail(part.body.data);
                break;
              }
            }
          }
          emailList.push(new Email(user.id, from, to, body));
        }
      }
      return emailList;
    } catch (error) {
      console.error('Gmail API error:', error);
      console.log('Falling back to mock data...');
      return this.getMockEmails(user);
    }
  }

  private getMockEmails(user: User): Email[] {
    console.log(`📧 Generating mock emails for user: ${user.email}`);
    return [
      new Email(user.id, 'noreply@starbucks.com', user.email, 
        'Thank you for your purchase at Starbucks! Total: $4.50\nItems: Grande Latte, Blueberry Muffin'),
      new Email(user.id, 'receipts@mcdonalds.com', user.email, 
        'McDonald\'s Receipt - Order #12345\nTotal: $8.99\nItems: Big Mac Meal, Apple Pie'),
      new Email(user.id, 'orders@chipotle.com', user.email, 
        'Chipotle Order Confirmation\nTotal: $12.75\nItems: Burrito Bowl, Chips & Guac')
    ];
  }
} 