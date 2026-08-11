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

interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GmailClient implements EmailClient {
  private getRequiredOAuthConfig(): GmailOAuthConfig {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
    const redirectUri = process.env.GMAIL_REDIRECT_URI?.trim();

    const missingVars: string[] = [];
    if (!clientId) missingVars.push('GMAIL_CLIENT_ID');
    if (!clientSecret) missingVars.push('GMAIL_CLIENT_SECRET');
    if (!redirectUri) missingVars.push('GMAIL_REDIRECT_URI');

    if (missingVars.length > 0) {
      throw new Error(`Missing required Gmail OAuth environment variables: ${missingVars.join(', ')}`);
    }

    return {
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri: redirectUri!,
    };
  }

  private hasUsableAccessToken(user: User): boolean {
    if (!user.gmailAccessToken) {
      return false;
    }

    if (!user.gmailTokenExpiry) {
      return true;
    }

    const expiry = new Date(user.gmailTokenExpiry).getTime();
    if (Number.isNaN(expiry)) {
      return false;
    }

    return expiry > Date.now();
  }

  private async createAuthenticatedGmailClient(user: User) {
    const { clientId, clientSecret, redirectUri } = this.getRequiredOAuthConfig();
    const hasRefreshToken = !!user.gmailRefreshToken;
    const hasAccessToken = this.hasUsableAccessToken(user);

    if (!hasRefreshToken && !hasAccessToken) {
      throw new Error('No usable Gmail credentials available for user');
    }

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    if (hasRefreshToken) {
      oAuth2Client.setCredentials({ refresh_token: user.gmailRefreshToken! });
      await oAuth2Client.getAccessToken();
    } else {
      oAuth2Client.setCredentials({ access_token: user.gmailAccessToken! });
    }

    return google.gmail({ version: 'v1', auth: oAuth2Client });
  }

  /**
   * Looks only for Uber's export-ready notification after the user requested it.
   * This deliberately does not open links or download the export archive.
   */
  async hasUberExportReadyEmail(user: User, requestedAt: string): Promise<boolean> {
    const requestedTimestamp = new Date(requestedAt).getTime();
    if (Number.isNaN(requestedTimestamp)) {
      return false;
    }

    if (config.shouldUseMockData() && !config.isProduction()) {
      const emails = this.loadEmailsFromDebugFolder(user);
      return emails.some((email) => this.isUberExportReadyMessage(
        email.from,
        email.subject ?? '',
        email.body
      ));
    }

    const gmail = await this.createAuthenticatedGmailClient(user);
    const afterSeconds = Math.floor(requestedTimestamp / 1000);
    const query = [
      '(from:noreply@uber.com OR from:uber.com OR from:ubereats.com)',
      `after:${afterSeconds}`,
      '(subject:"Your Uber data is ready for download" OR "Your Uber data is now ready" OR "GO TO DOWNLOAD PAGE")',
    ].join(' ');

    try {
      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const candidates = listResponse.data.messages ?? [];
      for (const candidate of candidates) {
        if (!candidate.id) continue;

        const messageResponse = await gmail.users.messages.get({
          userId: 'me',
          id: candidate.id,
        });
        const payload = messageResponse.data.payload;
        let from = '';
        let subject = '';
        for (const header of payload?.headers ?? []) {
          if (header.name?.toLowerCase() === 'from') from = header.value ?? '';
          if (header.name?.toLowerCase() === 'subject') subject = header.value ?? '';
        }

        const body = `${messageResponse.data.snippet ?? ''}\n${this.extractBody(payload)}`;
        if (this.isUberExportReadyMessage(from, subject, body)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown Gmail API error';
      throw new Error(`Failed to check for an Uber export-ready email: ${errorMessage}`);
    }
  }

  private isUberExportReadyMessage(from: string, subject: string, body: string): boolean {
    const normalizedFrom = from.toLowerCase();
    const isFromUber = /@(?:[a-z0-9-]+\.)?(?:uber|ubereats)\.com\b/i.test(normalizedFrom);
    if (!isFromUber) {
      return false;
    }

    const normalizedSubject = subject.toLowerCase();
    const normalizedBody = body.toLowerCase();
    const matchesConfirmedEmail = normalizedFrom.includes('noreply@uber.com')
      && normalizedSubject.includes('your uber data is ready for download');
    const hasReadyLanguage = normalizedBody.includes('your uber data is now ready')
      || normalizedBody.includes('ready for you to download');
    const hasDownloadAction = normalizedBody.includes('go to download page');
    const matchesKnownTemplate = normalizedSubject.includes('download your data')
      && normalizedBody.includes('available for 7 days')
      && normalizedBody.includes('sign in at the link below');

    return matchesConfirmedEmail
      || (hasReadyLanguage && hasDownloadAction)
      || matchesKnownTemplate;
  }

  async getEmails(user: User): Promise<Email[]> {
    if (config.shouldUseMockData() && !config.isProduction()) {
      console.log('🧪 USE_MOCK_DATA enabled, loading emails from debug-emails folder.');
      return this.loadEmailsFromDebugFolder(user);
    }

    const gmail = await this.createAuthenticatedGmailClient(user);
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
      const errorMsg = error instanceof Error ? error.message : 'Unknown Gmail API error';
      throw new Error(`Failed to fetch emails from Gmail: ${errorMsg}`);
    }
  }

  private loadEmailsFromDebugFolder(user: User): Email[] {
    const debugDir = path.join(process.cwd(), 'debug-emails');

    if (!fs.existsSync(debugDir)) {
      throw new Error(`USE_MOCK_DATA is enabled but debug-emails folder was not found at ${debugDir}`);
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
        throw new Error('USE_MOCK_DATA is enabled but no email JSON files were found in debug-emails');
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
        throw new Error(`Debug email file ${selectedFile.name} does not contain a valid email array`);
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
      throw error;
    }
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
