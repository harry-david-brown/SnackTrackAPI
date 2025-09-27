import { User } from '../../models/User';
import { Email } from './Email';
import { EmailClient } from './EmailClient';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config/AppConfig';

// Utility for base64 decoding (Gmail uses URL-safe base64)
function decodeBase64Gmail(str: string): string {
  const decoded = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return decoded;
}

export class GmailClient implements EmailClient {
  async getEmails(user: User): Promise<Email[]> {
    // Use centralized config to determine data source
    if (config.shouldUseMockData()) {
      console.log('🧪 Using mock Uber emails for testing.');
      return this.getMockEmails(user);
    }

    // Use real Gmail API (credentials are configured)
    const CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'your_client_id_here';
    const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'your_client_secret_here';
    const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/callback';
    const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || 'your_refresh_token_here';

    const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const emailList: Email[] = [];

    try {
      // Use centralized config for Gmail search query
      const searchQuery = config.getGmailSearchQuery();
      
      if (config.shouldEnableDetailedLogging()) {
        console.log('🔍 Gmail API: Searching for Uber emails with query:', searchQuery);
        console.log(config.getEnvironmentInfo());
      }
      
      const listRes = await gmail.users.messages.list({
        userId: 'me', // Use 'me' for the authenticated user
        q: searchQuery, // Use centralized config for search query
        maxResults: 100, // Get more emails since we're filtering at source
      });
      
      console.log('📧 Gmail API: Found', listRes.data.messages?.length || 0, 'Uber emails');

      if (listRes.data.messages) {
        for (const msg of listRes.data.messages) {
          console.log('📨 Gmail API: Processing email ID:', msg.id);
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
          console.log('📧 Email from:', from, 'to:', to);
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
      console.log('✅ Gmail API: Returning', emailList.length, 'emails to process');
      return emailList;
    } catch (error) {
      console.error('Gmail API error:', error);
      console.log('Falling back to mock data...');
      return this.getMockEmails(user);
    }
  }

  private getMockEmails(user: User): Email[] {
    console.log(`📧 Generating mock Uber emails for user: ${user.email}`);
    return [
      new Email(user.id, 'Uber Receipts <noreply@uber.com>', user.email, 
        'Your Tuesday evening order with Uber Eats\nTotal CA$30.87\nNovember 15, 2022\nThanks for ordering!\nHere\'s your receipt from Sushi Shop (South Keys) and Uber Eats.\nYou ordered from Sushi Shop (South Keys)\nDelivered to Ottawa, ON\nSubtotal: $25.00\nTax: $3.25\nTip: $2.50\nDelivery Fee: $0.12',
        'Your Tuesday evening order with Uber Eats'),
      new Email(user.id, 'Uber Receipts <noreply@uber.com>', user.email, 
        'Your Friday lunch order with Uber Eats\nTotal CA$18.50\nNovember 18, 2022\nThanks for ordering!\nHere\'s your receipt from McDonald\'s and Uber Eats.\nYou ordered from McDonald\'s\nDelivered to Ottawa, ON\nSubtotal: $15.00\nTax: $1.95\nTip: $1.50\nDelivery Fee: $0.05',
        'Your Friday lunch order with Uber Eats'),
      new Email(user.id, 'Uber Receipts <noreply@uber.com>', user.email, 
        'Your Sunday brunch order with Uber Eats\nTotal CA$42.30\nNovember 20, 2022\nThanks for ordering!\nHere\'s your receipt from Tim Hortons and Uber Eats.\nYou ordered from Tim Hortons\nDelivered to Ottawa, ON\nSubtotal: $35.00\nTax: $4.55\nTip: $2.75\nDelivery Fee: $0.00',
        'Your Sunday brunch order with Uber Eats')
    ];
  }
} 