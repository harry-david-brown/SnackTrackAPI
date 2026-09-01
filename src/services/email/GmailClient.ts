import { User } from '../../models/User';
import { MailboxClient, MailboxMessage } from '../ports/MailboxPorts';
import { google } from 'googleapis';
import { config } from '../../config/AppConfig';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';
import { silentStructuredLogger, StructuredLogger } from '../core/StructuredLogger';
import type { EmailDebugCapturePort } from '../ports/MailboxPorts';
import { DisabledEmailDebugCapture } from './EmailDebugCapture';
import {
  decodeGmailMessage,
  decodeGmailMessageList,
  decodeGmailProfile,
  DecodedGmailPart,
} from './GmailProviderDecoder';

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

export class GmailClient implements MailboxClient {
  constructor(
    private readonly logger: StructuredLogger = silentStructuredLogger,
    private readonly debugCapture: EmailDebugCapturePort = new DisabledEmailDebugCapture(),
  ) {}

  private getRequiredOAuthConfig(): GmailOAuthConfig {
    const { clientId, clientSecret, redirectUri } = config.getGmailConfig();

    if (!clientId || !clientSecret || !redirectUri) {
      const missingVars = [
        !clientId && 'GMAIL_CLIENT_ID',
        !clientSecret && 'GMAIL_CLIENT_SECRET',
        !redirectUri && 'GMAIL_REDIRECT_URI',
      ].filter((name): name is string => Boolean(name));
      throw new Error(
        `Missing required Gmail OAuth environment variables: ${missingVars.join(', ')}`,
      );
    }

    return {
      clientId,
      clientSecret,
      redirectUri,
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

  /** Refreshes the credential and performs a minimal Gmail API request. */
  async validateConnection(user: User): Promise<void> {
    if (config.shouldUseMockData() && !config.isProduction()) return;
    const gmail = await this.createAuthenticatedGmailClient(user);
    decodeGmailProfile(await gmail.users.getProfile({ userId: 'me', fields: 'emailAddress' }));
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
      return emails.some((email) =>
        this.isUberExportReadyMessage(email.from, email.subject ?? '', email.body),
      );
    }

    const gmail = await this.createAuthenticatedGmailClient(user);
    const afterSeconds = Math.floor(requestedTimestamp / 1000);
    const query = [
      '(from:noreply@uber.com OR from:uber.com OR from:ubereats.com)',
      `after:${afterSeconds}`,
      '(subject:"Your Uber data is ready for download" OR "Your Uber data is now ready" OR "GO TO DOWNLOAD PAGE")',
    ].join(' ');

    try {
      const candidates = decodeGmailMessageList(
        await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 10,
        }),
      );

      for (const messageId of candidates.messageIds) {
        const message = decodeGmailMessage(
          await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
          }),
        );
        const payload = message.payload;
        let from = '';
        let subject = '';
        for (const header of payload?.headers ?? []) {
          if (header.name.toLowerCase() === 'from') from = header.value;
          if (header.name.toLowerCase() === 'subject') subject = header.value;
        }

        const body = `${message.snippet ?? ''}\n${this.extractBody(payload)}`;
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
    const matchesConfirmedEmail =
      normalizedFrom.includes('noreply@uber.com') &&
      normalizedSubject.includes('your uber data is ready for download');
    const hasReadyLanguage =
      normalizedBody.includes('your uber data is now ready') ||
      normalizedBody.includes('ready for you to download');
    const hasDownloadAction = normalizedBody.includes('go to download page');
    const matchesKnownTemplate =
      normalizedSubject.includes('download your data') &&
      normalizedBody.includes('available for 7 days') &&
      normalizedBody.includes('sign in at the link below');

    return matchesConfirmedEmail || (hasReadyLanguage && hasDownloadAction) || matchesKnownTemplate;
  }

  async getEmails(user: User, options?: { after?: Date }): Promise<MailboxMessage[]> {
    if (config.shouldUseMockData() && !config.isProduction()) {
      this.logger.info('Loading Gmail messages from configured mock fixtures', {
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'mock_source',
      });
      return this.loadEmailsFromDebugFolder(user);
    }

    const gmail = await this.createAuthenticatedGmailClient(user);
    const emailList: MailboxMessage[] = [];

    try {
      // Use centralized config for Gmail search query
      const baseSearchQuery = config.getGmailSearchQuery();
      const afterSeconds = options?.after ? Math.floor(options.after.getTime() / 1000) : null;
      const searchQuery =
        afterSeconds && Number.isFinite(afterSeconds)
          ? `(${baseSearchQuery}) after:${afterSeconds}`
          : baseSearchQuery;

      if (config.shouldEnableDetailedLogging()) {
        this.logger.debug('Gmail message search started', {
          userId: user.id,
          operation: 'gmail_message_fetch',
          provider: 'gmail',
          outcome: 'started',
          incremental: afterSeconds !== null,
        });
      }

      // Concurrency limiter for parallel Gmail API calls
      // Limit to 10 concurrent requests to avoid rate limiting
      const limit = pLimit(10);

      // Helper function to process a single message
      const fetchSingleMessage = async (msgId: string): Promise<MailboxMessage | null> => {
        try {
          const message = decodeGmailMessage(
            await gmail.users.messages.get({
              userId: 'me',
              id: msgId,
            }),
          );
          const payload = message.payload;
          let from = '',
            to = '',
            subject = '',
            dateHeader = '',
            body = '';
          if (payload && payload.headers) {
            for (const header of payload.headers) {
              if (header.name === 'From') from = header.value || '';
              if (header.name === 'To') to = header.value || '';
              if (header.name === 'Subject') subject = header.value || '';
              if (header.name === 'Date') dateHeader = header.value || '';
            }
          }
          // Get the body (handle multipart)
          body = this.extractBody(payload);
          const internalTimestamp = Number(message.internalDate);
          const receivedAt = Number.isFinite(internalTimestamp)
            ? new Date(internalTimestamp)
            : dateHeader
              ? new Date(dateHeader)
              : undefined;
          return new MailboxMessage(
            user.id,
            from,
            to,
            body,
            subject,
            msgId,
            receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined,
          );
        } catch (error) {
          this.logger.warn('Gmail message fetch failed', {
            userId: user.id,
            operation: 'gmail_message_fetch',
            provider: 'gmail',
            outcome: 'message_failure',
            error,
          });
          return null;
        }
      };

      // Helper function to process a batch of messages in parallel
      const processMessages = async (messageIds: readonly string[]) => {
        if (messageIds.length === 0) return;

        const startTime = Date.now();

        // Create limited promises for all messages
        const promises = messageIds.map((messageId) => limit(() => fetchSingleMessage(messageId)));

        // Wait for all to complete
        const results = await Promise.all(promises);

        // Filter out failed fetches and add to email list
        const successfulEmails = results.filter((email): email is MailboxMessage => email !== null);
        emailList.push(...successfulEmails);

        this.logger.debug('Gmail message page fetched', {
          userId: user.id,
          operation: 'gmail_message_fetch',
          provider: 'gmail',
          outcome: 'page_fetched',
          requestedCount: messageIds.length,
          fetchedCount: successfulEmails.length,
          durationMs: Date.now() - startTime,
        });
      };

      // Fetch emails with pagination
      let nextPageToken: string | null | undefined = undefined;
      let pageCount = 0;
      let totalMessagesFound = 0;

      while (true) {
        pageCount++;
        const page = decodeGmailMessageList(
          await gmail.users.messages.list({
            userId: 'me', // Use 'me' for the authenticated user
            q: searchQuery, // Use centralized config for search query
            maxResults: 500, // Maximum allowed by Gmail API
            pageToken: nextPageToken || undefined,
          }),
        );

        const messagesInPage = page.messageIds.length;
        totalMessagesFound += messagesInPage;

        // Process messages from this page in parallel
        await processMessages(page.messageIds);

        // Check if there are more pages
        nextPageToken = page.nextPageToken || null;

        if (!nextPageToken) {
          break; // No more pages
        }
      }

      this.logger.info('Gmail message search completed', {
        userId: user.id,
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'success',
        pageCount,
        messagesFound: totalMessagesFound,
        messagesFetched: emailList.length,
      });
      await this.debugCapture.capture('gmail-message-fetch', {
        userId: user.id,
        pageCount,
        messagesFound: totalMessagesFound,
        messagesFetched: emailList.length,
      });
      return emailList;
    } catch (error) {
      this.logger.error('Gmail message search failed', {
        userId: user.id,
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'failure',
        error,
      });
      const errorMsg = error instanceof Error ? error.message : 'Unknown Gmail API error';
      throw new Error(`Failed to fetch emails from Gmail: ${errorMsg}`);
    }
  }

  private loadEmailsFromDebugFolder(user: User): MailboxMessage[] {
    const debugDir = path.join(process.cwd(), 'debug-emails');

    if (!fs.existsSync(debugDir)) {
      throw new Error(
        `USE_MOCK_DATA is enabled but debug-emails folder was not found at ${debugDir}`,
      );
    }

    try {
      // Find all JSON files in the debug-emails folder, excluding unknown-restaurants files
      const files = fs
        .readdirSync(debugDir)
        .filter((file) => file.endsWith('.json') && !file.includes('unknown-restaurants'))
        .map((file) => ({
          name: file,
          path: path.join(debugDir, file),
          stats: fs.statSync(path.join(debugDir, file)),
          isGmailEmails: file.startsWith('gmail-emails'),
        }))
        // Sort: prefer gmail-emails files, then by modification time (newest first)
        .sort((a, b) => {
          if (a.isGmailEmails && !b.isGmailEmails) return -1;
          if (!a.isGmailEmails && b.isGmailEmails) return 1;
          return b.stats.mtime.getTime() - a.stats.mtime.getTime();
        });

      if (files.length === 0) {
        throw new Error(
          'USE_MOCK_DATA is enabled but no email JSON files were found in debug-emails',
        );
      }

      // Load the most recent/preferred file
      const selectedFile = files[0];
      this.logger.debug('Loading Gmail mock fixture', {
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'mock_fixture_selected',
      });

      const fileContent = fs.readFileSync(selectedFile.path, 'utf8');
      const parsedContent: unknown = JSON.parse(fileContent);

      // Handle both direct array format and nested format (for unknown-restaurants files that might slip through)
      let emailsJson: unknown[];
      if (Array.isArray(parsedContent)) {
        emailsJson = parsedContent;
      } else if (
        parsedContent &&
        typeof parsedContent === 'object' &&
        !Array.isArray(parsedContent) &&
        Array.isArray((parsedContent as Record<string, unknown>).emails)
      ) {
        // Handle nested format (unknown-restaurants files)
        emailsJson = (parsedContent as { emails: unknown[] }).emails;
      } else {
        throw new Error(
          `Debug email file ${selectedFile.name} does not contain a valid email array`,
        );
      }

      // Convert JSON objects to Email objects
      const emails = emailsJson.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Debug email file ${selectedFile.name} contains an invalid email entry`);
        }
        const emailData = value as Record<string, unknown>;
        const field = (name: string, fallback: string): string => {
          const candidate = emailData[name];
          if (candidate === undefined || candidate === null) return fallback;
          if (typeof candidate !== 'string') {
            throw new Error(`Debug email field ${name} must be a string`);
          }
          return candidate;
        };
        // ALWAYS use the current user's ID, overriding any userId in the debug JSON
        // This ensures receipts are saved for the currently logged-in user
        return new MailboxMessage(
          user.id, // Always use current user's ID
          field('from', ''),
          field('to', user.email),
          field('body', ''),
          field('subject', ''),
        );
      });

      this.logger.info('Gmail mock fixture loaded', {
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'mock_loaded',
        messagesFetched: emails.length,
      });
      return emails;
    } catch (error) {
      this.logger.error('Gmail mock fixture load failed', {
        operation: 'gmail_message_fetch',
        provider: 'gmail',
        outcome: 'failure',
        error,
      });
      throw error;
    }
  }

  private extractBody(part: DecodedGmailPart | null | undefined): string {
    if (!part) return '';

    // 1. Direct match: HTML
    if (part.mimeType === 'text/html' && part.bodyData) {
      return decodeBase64Gmail(part.bodyData);
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
    if (part.mimeType === 'text/plain' && part.bodyData) {
      return decodeBase64Gmail(part.bodyData);
    }

    return '';
  }

  // Helper to strictly find HTML content
  private extractHtmlOnly(part: DecodedGmailPart | null | undefined): string | null {
    if (!part) return null;

    if (part.mimeType === 'text/html' && part.bodyData) {
      return decodeBase64Gmail(part.bodyData);
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
