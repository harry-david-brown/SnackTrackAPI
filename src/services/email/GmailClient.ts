import { User } from '../../models/User';
import { Email } from './Email';
import { EmailClient } from './EmailClient';
import { google } from 'googleapis';
import { config } from '../../config/AppConfig';
import { ReceiptExtractor, RawEmail } from '../extraction';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';

// Utility for base64 decoding (Gmail uses URL-safe base64)
function decodeBase64Gmail(str: string): string {
  const decoded = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return decoded;
}

export class GmailClient implements EmailClient {
  async getEmails(user: User): Promise<Email[]> {
    // Use centralized config to determine data source
    // NEVER use mock data in production
    if (config.shouldUseMockData() && !config.isProduction()) {
      console.log('🧪 Using mock Uber emails for testing (development mode).');
      return this.loadEmailsFromDebugFolder(user);
    }

    // Use real Gmail API with user-specific tokens
    // IMPORTANT: Use the same OAuth client credentials that were used to issue the refresh token
    // For mobile OAuth, this is the web client ID (GMAIL_CLIENT_ID)
    const CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'your_client_id_here';
    const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'your_client_secret_here';
    const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/gmail/callback';

    if (!CLIENT_ID || CLIENT_ID === 'your_client_id_here' || !CLIENT_SECRET || CLIENT_SECRET === 'your_client_secret_here') {
      const errorMsg = 'Gmail OAuth client credentials not configured';
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Use user's refresh token if available, otherwise fall back to env var (for backward compatibility)
    const REFRESH_TOKEN = user.gmailRefreshToken || process.env.GMAIL_REFRESH_TOKEN || 'your_refresh_token_here';

    if (!REFRESH_TOKEN || REFRESH_TOKEN === 'your_refresh_token_here') {
      const errorMsg = 'No Gmail refresh token available for user';
      console.error(`❌ ${errorMsg}`);

      // In production, throw an error instead of falling back to mock data
      if (config.isProduction()) {
        throw new Error(errorMsg);
      }

      // In development, fall back to mock data for testing
      console.log('⚠️ Falling back to mock data (development mode)');
      return this.getMockEmails(user);
    }

    // Create OAuth2Client with the same credentials used to issue the token
    // This must match the web client ID used in the mobile app's GoogleSignin.configure()
    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

    // Try to determine if this is an access token or refresh token
    // Access tokens typically start with "ya29." or are shorter
    // Refresh tokens are longer and don't have a specific prefix
    // However, the safest approach is to try refresh first, and if it fails, use as access token
    const looksLikeAccessToken = REFRESH_TOKEN.startsWith('ya29.') ||
      REFRESH_TOKEN.startsWith('1//') === false && REFRESH_TOKEN.length < 150;

    if (looksLikeAccessToken) {
      // This looks like an access token - use it directly (don't try to refresh)
      console.log(`🔐 Using access token directly (expires in ~1 hour)`);
      oAuth2Client.setCredentials({ access_token: REFRESH_TOKEN });
    } else {
      // This looks like a refresh token - use it to get access tokens
      console.log(`🔐 Using refresh token to get access tokens`);
      try {
        oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
        // Try to get an access token to verify it works
        await oAuth2Client.getAccessToken();
      } catch (error: any) {
        // If refresh fails with "unauthorized_client", it might actually be an access token
        if (error.message?.includes('unauthorized_client') || error.message?.includes('invalid_grant')) {
          console.log(`⚠️ Refresh token failed, trying as access token instead`);
          oAuth2Client.setCredentials({ access_token: REFRESH_TOKEN });
        } else {
          throw error;
        }
      }
    }

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const emailList: Email[] = [];

    try {
      // Use centralized config for Gmail search query
      const searchQuery = config.getGmailSearchQuery();

      if (config.shouldEnableDetailedLogging()) {
        console.log('🔍 Gmail API: Searching for Uber emails with query:', searchQuery);
        console.log(config.getEnvironmentInfo());
      }

      // Concurrency limiter for parallel Gmail API calls
      // Limit to 10 concurrent requests to avoid rate limiting
      const limit = pLimit(10);

      // Helper function to process a single message
      const fetchSingleMessage = async (msgId: string): Promise<Email | null> => {
        try {
          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: msgId,
          });
          const payload = msgRes.data.payload;
          let from = '', to = '', subject = '', body = '';
          if (payload && payload.headers) {
            for (const header of payload.headers) {
              if (header.name === 'From') from = header.value || '';
              if (header.name === 'To') to = header.value || '';
              if (header.name === 'Subject') subject = header.value || '';
            }
          }
          // Get the body (handle multipart)
          body = this.extractBody(payload);
          return new Email(user.id, from, to, body, subject);
        } catch (error) {
          console.error(`❌ Failed to fetch message ${msgId}:`, error);
          return null;
        }
      };

      // Helper function to process a batch of messages in parallel
      const processMessages = async (messages: Array<{ id?: string | null }> | undefined) => {
        if (!messages || messages.length === 0) return;

        console.log(`📨 Gmail API: Fetching ${messages.length} messages in parallel (concurrency: 10)...`);
        const startTime = Date.now();

        // Create limited promises for all messages
        const promises = messages
          .filter(msg => msg.id)
          .map(msg => limit(() => fetchSingleMessage(msg.id!)));

        // Wait for all to complete
        const results = await Promise.all(promises);

        // Filter out failed fetches and add to email list
        const successfulEmails = results.filter((email): email is Email => email !== null);
        emailList.push(...successfulEmails);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ Gmail API: Fetched ${successfulEmails.length}/${messages.length} messages in ${duration}s`);
      };

      // Fetch emails with pagination
      let nextPageToken: string | null | undefined = undefined;
      let pageCount = 0;
      let totalMessagesFound = 0;

      while (true) {
        pageCount++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listRes: any = await gmail.users.messages.list({
          userId: 'me', // Use 'me' for the authenticated user
          q: searchQuery, // Use centralized config for search query
          maxResults: 500, // Maximum allowed by Gmail API
          pageToken: nextPageToken || undefined,
        });

        const messagesInPage = listRes.data.messages?.length || 0;
        totalMessagesFound += messagesInPage;

        console.log(`📧 Gmail API: Page ${pageCount} - Found ${messagesInPage} emails (Total so far: ${totalMessagesFound})`);

        // Process messages from this page in parallel
        await processMessages(listRes.data.messages);

        // Check if there are more pages
        nextPageToken = listRes.data.nextPageToken || null;

        if (!nextPageToken) {
          break; // No more pages
        }

        console.log(`📄 Gmail API: More pages available, fetching next page...`);
      }

      console.log(`📧 Gmail API: Completed pagination - Found ${totalMessagesFound} total Uber emails across ${pageCount} page(s)`);

      if (config.shouldSaveDebugEmails()) {
        // Save emails to JSON for debugging
        try {
          const debugDir = path.join(process.cwd(), 'debug-emails');
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
          }

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `gmail-emails-${user.id}-${timestamp}.json`;
          const filepath = path.join(debugDir, filename);

          // Convert emails to JSON-serializable format
          const emailsJson = emailList.map(email => ({
            userId: email.userId,
            from: email.from,
            to: email.to,
            body: email.body,
            subject: email.subject
          }));

          fs.writeFileSync(filepath, JSON.stringify(emailsJson, null, 2));
          console.log(`🔍 DEBUG: Saved ${emailList.length} emails to ${filepath}`);

          // Also save emails with unknown restaurants (without body) for debugging
          try {
            const extractor = new ReceiptExtractor();
            const unknownRestaurantEmails: any[] = [];

            for (const email of emailList) {
              const rawEmail: RawEmail = {
                userId: email.userId,
                from: email.from,
                to: email.to,
                body: email.body,
                subject: email.subject
              };

              const result = extractor.extract(rawEmail);

              // Check if it's a receipt but merchant is unknown/null
              if (result.classification.isReceipt && (!result.data?.merchant || result.data.merchant === 'Unknown')) {
                unknownRestaurantEmails.push({
                  userId: email.userId,
                  from: email.from,
                  to: email.to,
                  subject: email.subject,
                  // body is intentionally excluded
                  extractedData: {
                    merchant: result.data?.merchant || null,
                    total: result.data?.total || null,
                    orderDate: result.data?.orderDate || null,
                    currency: result.data?.currency || null
                  }
                });
              }
            }

            if (unknownRestaurantEmails.length > 0) {
              const unknownFilename = `unknown-restaurants-${user.id}-${timestamp}.json`;
              const unknownFilepath = path.join(debugDir, unknownFilename);

              fs.writeFileSync(unknownFilepath, JSON.stringify({
                userId: user.id,
                timestamp: new Date().toISOString(),
                count: unknownRestaurantEmails.length,
                emails: unknownRestaurantEmails
              }, null, 2));

              console.log(`🔍 DEBUG: Saved ${unknownRestaurantEmails.length} unknown restaurant emails to ${unknownFilepath}`);
            } else {
              console.log(`✅ All restaurants identified successfully!`);
            }
          } catch (extractionError) {
            console.error('❌ Failed to create unknown-restaurants debug file:', extractionError);
          }
        } catch (error) {
          console.error('❌ Failed to save debug emails to JSON:', error);
        }
      }

      console.log('✅ Gmail API: Returning', emailList.length, 'emails to process');
      return emailList;
    } catch (error) {
      console.error('Gmail API error:', error);

      // In production, throw the error instead of falling back to mock data
      if (config.isProduction()) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown Gmail API error';
        console.error(`❌ Gmail API error in production: ${errorMsg}`);
        throw new Error(`Failed to fetch emails from Gmail: ${errorMsg}`);
      }

      // In development, fall back to mock data for testing
      console.log('⚠️ Falling back to mock data (development mode)');
      return this.getMockEmails(user);
    }
  }

  private loadEmailsFromDebugFolder(user: User): Email[] {
    const debugDir = path.join(process.cwd(), 'debug-emails');

    if (!fs.existsSync(debugDir)) {
      console.log(`⚠️ Debug-emails folder not found at ${debugDir}, falling back to generated mock emails`);
      return this.getMockEmails(user);
    }

    try {
      // Find all JSON files in the debug-emails folder, excluding unknown-restaurants files
      const files = fs.readdirSync(debugDir)
        .filter(file => file.endsWith('.json') && !file.includes('unknown-restaurants'))
        .map(file => ({
          name: file,
          path: path.join(debugDir, file),
          stats: fs.statSync(path.join(debugDir, file)),
          isGmailEmails: file.startsWith('gmail-emails')
        }))
        // Sort: prefer gmail-emails files, then by modification time (newest first)
        .sort((a, b) => {
          if (a.isGmailEmails && !b.isGmailEmails) return -1;
          if (!a.isGmailEmails && b.isGmailEmails) return 1;
          return b.stats.mtime.getTime() - a.stats.mtime.getTime();
        });

      if (files.length === 0) {
        console.log(`⚠️ No email JSON files found in debug-emails folder, falling back to generated mock emails`);
        return this.getMockEmails(user);
      }

      // Load the most recent/preferred file
      const selectedFile = files[0];
      console.log(`📂 Loading emails from debug file: ${selectedFile.name}`);

      const fileContent = fs.readFileSync(selectedFile.path, 'utf8');
      const parsedContent = JSON.parse(fileContent);

      // Handle both direct array format and nested format (for unknown-restaurants files that might slip through)
      let emailsJson: any[];
      if (Array.isArray(parsedContent)) {
        emailsJson = parsedContent;
      } else if (parsedContent.emails && Array.isArray(parsedContent.emails)) {
        // Handle nested format (unknown-restaurants files)
        console.log(`⚠️ File contains nested format, extracting emails array`);
        emailsJson = parsedContent.emails;
      } else {
        console.log(`⚠️ JSON file does not contain a valid email array, falling back to generated mock emails`);
        return this.getMockEmails(user);
      }

      // Convert JSON objects to Email objects
      const emails = emailsJson.map((emailData: any) => {
        // ALWAYS use the current user's ID, overriding any userId in the debug JSON
        // This ensures receipts are saved for the currently logged-in user
        return new Email(
          user.id,  // Always use current user's ID
          emailData.from || '',
          emailData.to || user.email,
          emailData.body || '',
          emailData.subject || ''
        );
      });

      console.log(`✅ Loaded ${emails.length} emails from debug-emails folder`);
      return emails;
    } catch (error) {
      console.error('❌ Error loading emails from debug-emails folder:', error);
      console.log('Falling back to generated mock emails');
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

  private extractBody(part: any): string {
    if (!part) return '';

    // 1. Direct match: HTML
    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBase64Gmail(part.body.data);
    }

    // 2. Multipart: Search children with priority
    if (part.parts) {
      // Pass 1: Strictly look for HTML in children
      for (const p of part.parts) {
        // Optimization: check direct child first
        if (p.mimeType === 'text/html') {
          return this.extractBody(p);
        }
        // Recurse strictly for HTML
        if (p.parts) {
          const html = this.extractHtmlOnly(p);
          if (html) return html;
        }
      }

      // Pass 2: If no HTML found, look for any content (Text)
      for (const p of part.parts) {
        const content = this.extractBody(p);
        if (content) return content;
      }
    }

    // 3. Fallback: Plain Text
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decodeBase64Gmail(part.body.data);
    }

    return '';
  }

  // Helper to strictly find HTML content
  private extractHtmlOnly(part: any): string | null {
    if (!part) return null;

    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBase64Gmail(part.body.data);
    }

    if (part.parts) {
      for (const p of part.parts) {
        const html = this.extractHtmlOnly(p);
        if (html) return html;
      }
    }

    return null;
  }
}