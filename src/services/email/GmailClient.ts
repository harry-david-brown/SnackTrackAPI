import { classifyGmailRequestFailure, gmailFailureDiagnostics } from './GmailRequestFailure';
import { User } from '../../models/User';
import { MailboxClient, MailboxMessage, type MailboxMessagePage, type MailboxReadSafety } from '../ports/MailboxPorts';
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
import { AppError } from '../../core/errors';
import { MailboxContentGuard } from '../mailbox/MailboxContentGuard';
import {
  GmailQuotaPacer,
  GMAIL_MESSAGE_GET_QUERY_UNITS,
  GMAIL_MESSAGE_LIST_QUERY_UNITS,
} from './GmailQuotaPacer';

const MAX_IMPORT_MESSAGES = 20_000;
const MAX_IMPORT_PAGES = 1_000;
const MAX_IMPORT_DURATION_MS = 15 * 60 * 1000;
const GMAIL_LIST_PAGE_SIZE = 500;
const GMAIL_PROCESSING_BATCH_SIZE = 20;
const GMAIL_BUFFERED_CURSOR_V1_PREFIX = 'snacktrack:gmail-buffer:v1:';
const GMAIL_BUFFERED_CURSOR_V2_PREFIX = 'snacktrack:gmail-buffer:v2:';

type GmailSearchQueryVersion = 1 | 2;

interface GmailBufferedCursor {
  readonly pendingMessageIds: readonly string[];
  readonly nextPageToken: string | null;
  readonly searchQueryVersion: GmailSearchQueryVersion;
  readonly estimatedTotalCount?: number;
}

const encodeGmailBufferedCursor = (cursor: GmailBufferedCursor): string =>
  `${cursor.searchQueryVersion === 1 ? GMAIL_BUFFERED_CURSOR_V1_PREFIX : GMAIL_BUFFERED_CURSOR_V2_PREFIX}${Buffer.from(JSON.stringify({
    pendingMessageIds: cursor.pendingMessageIds,
    nextPageToken: cursor.nextPageToken,
    estimatedTotalCount: cursor.estimatedTotalCount,
  })).toString('base64url')}`;

const decodeGmailBufferedCursor = (cursor: string): GmailBufferedCursor => {
  try {
    const searchQueryVersion: GmailSearchQueryVersion = cursor.startsWith(GMAIL_BUFFERED_CURSOR_V2_PREFIX) ? 2 : 1;
    const prefix = searchQueryVersion === 2 ? GMAIL_BUFFERED_CURSOR_V2_PREFIX : GMAIL_BUFFERED_CURSOR_V1_PREFIX;
    const decoded = JSON.parse(
      Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const pendingMessageIds = decoded.pendingMessageIds;
    const nextPageToken = decoded.nextPageToken;
    const estimatedTotalCount = decoded.estimatedTotalCount;
    if (
      !Array.isArray(pendingMessageIds) ||
      pendingMessageIds.length > MAX_IMPORT_MESSAGES ||
      pendingMessageIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256) ||
      (nextPageToken !== null && typeof nextPageToken !== 'string') ||
      (estimatedTotalCount !== undefined &&
        (typeof estimatedTotalCount !== 'number' || !Number.isInteger(estimatedTotalCount) || estimatedTotalCount < 0)) ||
      (pendingMessageIds.length === 0 && nextPageToken === null)
    ) throw new Error('Invalid buffered Gmail cursor');
    return {
      pendingMessageIds: pendingMessageIds as string[],
      nextPageToken: nextPageToken as string | null,
      searchQueryVersion,
      estimatedTotalCount: estimatedTotalCount as number | undefined,
    };
  } catch (error) {
    throw new AppError({
      code: 'IMPORT_CHECKPOINT_INVALID',
      message: 'Invalid buffered Gmail checkpoint cursor',
      publicMessage: 'This import could not be resumed safely. Start a new import.',
      cause: error,
    });
  }
};

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

type GmailApiClient = ReturnType<typeof google.gmail>;

export class GmailClient implements MailboxClient {
  private readonly contentGuard = new MailboxContentGuard();
  constructor(
    private readonly logger: StructuredLogger = silentStructuredLogger,
    private readonly debugCapture: EmailDebugCapturePort = new DisabledEmailDebugCapture(),
    private readonly clientOverride?: GmailApiClient,
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

  private async createAuthenticatedGmailClient(user: User): Promise<GmailApiClient> {
    if (this.clientOverride) return this.clientOverride;
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

  async getEmails(user: User, options?: { after?: Date; safety?: MailboxReadSafety }): Promise<MailboxMessage[]> {
    const safeMessages: MailboxMessage[] = [];
    for await (const page of this.getEmailPages(user, options)) {
      safeMessages.push(...page.messages);
      if (safeMessages.length > MAX_IMPORT_MESSAGES) {
        throw new AppError({
          code: 'MAILBOX_IMPORT_LIMIT_REACHED',
          message: 'Gmail import exceeded its message budget',
          publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
        });
      }
    }
    return safeMessages;
  }

  /** Production import path: lists the bounded workload, then yields one processing batch at a time. */
  async *getEmailPages(
    user: User,
    options?: { after?: Date; cursor?: string; safety?: MailboxReadSafety },
  ): AsyncIterable<MailboxMessagePage> {
    if (config.shouldUseMockData() && !config.isProduction()) {
      const emails = this.loadEmailsFromDebugFolder(user);
      const match = options?.cursor?.match(/^mock:(\d+)$/);
      if (options?.cursor && !match) {
        throw new AppError({ code: 'IMPORT_CHECKPOINT_INVALID', message: 'Invalid Gmail mock cursor' });
      }
      const offset = match ? Number(match[1]) : 0;
      if (emails.length === 0) {
        yield { messages: [], matchedCount: 0, nextCursor: null };
        return;
      }
      for (let index = offset; index < emails.length; index += 20) {
        const candidates = emails.slice(index, index + 20);
        const messages = candidates.flatMap((message) => {
          const preflight = this.contentGuard.preflight({
            provider: 'gmail', from: message.from, to: message.to, subject: message.subject,
            providerBytes: Buffer.byteLength(JSON.stringify(message)),
            allowForwardedReceipts: options?.safety?.allowForwardedReceipts ?? false,
          });
          const guarded = this.contentGuard.acceptBody(message.body, preflight);
          return guarded.accepted
            ? [new MailboxMessage(message.userId, message.from, message.to, guarded.body, message.subject, message.providerMessageId, message.receivedAt, 'gmail')]
            : [];
        });
        const next = index + candidates.length;
        yield {
          messages,
          matchedCount: candidates.length,
          estimatedTotalCount: emails.length,
          rejectedCount: candidates.length - messages.length,
          decodedBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0),
          nextCursor: next < emails.length ? `mock:${next}` : null,
        };
      }
      return;
    }

    const gmail = await this.createAuthenticatedGmailClient(user);
    const isBufferedCursor = options?.cursor?.startsWith(GMAIL_BUFFERED_CURSOR_V1_PREFIX) ||
      options?.cursor?.startsWith(GMAIL_BUFFERED_CURSOR_V2_PREFIX);
    const bufferedCursor = isBufferedCursor && options?.cursor
      ? decodeGmailBufferedCursor(options.cursor)
      : null;
    // Raw provider tokens and v1 buffered cursors belong to imports that began
    // before subject filtering. Keep their query stable because Gmail page
    // tokens are tied to the original search.
    const searchQueryVersion: GmailSearchQueryVersion = bufferedCursor?.searchQueryVersion ??
      (options?.cursor ? 1 : 2);
    const senderQuery = config.getGmailSearchQuery();
    const baseSearchQuery = searchQueryVersion === 1
      ? (options?.safety?.allowForwardedReceipts
        ? `(${senderQuery}) OR ((subject:Uber OR subject:DoorDash) (receipt OR order))`
        : senderQuery)
      : (options?.safety?.allowForwardedReceipts
        ? `((${senderQuery}) OR (subject:Uber OR subject:DoorDash)) subject:order`
        : `(${senderQuery}) subject:order`);
    const afterSeconds = options?.after ? Math.floor(options.after.getTime() / 1000) : null;
    const searchQuery = afterSeconds && Number.isFinite(afterSeconds)
      ? `(${baseSearchQuery}) after:${afterSeconds}`
      : baseSearchQuery;
    const limit = pLimit(5);
    const quotaPacer = new GmailQuotaPacer(config.getGmailConfig().importQueryUnitsPerMinute);
    let gmailRequestCount = 0;
    let modeledQueryUnits = 0;
    let pageFailure: unknown;
    let pageToken: string | null | undefined = bufferedCursor
      ? bufferedCursor.nextPageToken
      : options?.cursor;
    let pendingMessageIds = bufferedCursor ? [...bufferedCursor.pendingMessageIds] : [];
    let estimatedTotalCount = bufferedCursor?.estimatedTotalCount;
    let pageCount = 0;
    const startedAt = Date.now();

    try {
      // Exhaust the Gmail listing before fetching any message bodies. This gives
      // new imports an exact, bounded workload for progress and time estimates.
      let hasMoreListPages = bufferedCursor ? pageToken !== null : true;
      while (hasMoreListPages) {
        if (Date.now() - startedAt > MAX_IMPORT_DURATION_MS) {
          throw new AppError({
            code: 'MAILBOX_IMPORT_LIMIT_REACHED',
            message: 'Gmail import exceeded its time budget',
            publicMessage: 'This mailbox is too large to import safely in one operation.',
          });
        }
        pageCount += 1;
        if (pageCount > MAX_IMPORT_PAGES) {
          throw new AppError({
            code: 'MAILBOX_IMPORT_LIMIT_REACHED',
            message: 'Gmail import exceeded its page budget',
            publicMessage: 'This mailbox is too large to import safely in one operation.',
          });
        }
        await quotaPacer.waitFor(GMAIL_MESSAGE_LIST_QUERY_UNITS);
        gmailRequestCount += 1;
        modeledQueryUnits += GMAIL_MESSAGE_LIST_QUERY_UNITS;
        const page = decodeGmailMessageList(await gmail.users.messages.list({
          userId: 'me', q: searchQuery, maxResults: GMAIL_LIST_PAGE_SIZE, pageToken: pageToken || undefined,
        }, { retry: false }));
        pendingMessageIds.push(...page.messageIds);
        if (pendingMessageIds.length > MAX_IMPORT_MESSAGES) {
          throw new AppError({
            code: 'MAILBOX_IMPORT_LIMIT_REACHED',
            message: 'Gmail import exceeded its message budget while listing matches',
            publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
          });
        }
        pageToken = page.nextPageToken || null;
        hasMoreListPages = pageToken !== null;
      }

      // Buffered cursors from imports started by an older deployment may already
      // carry a provider estimate that includes messages processed before resume.
      estimatedTotalCount = bufferedCursor?.estimatedTotalCount ?? pendingMessageIds.length;
      this.logger.info('Gmail message listing completed', {
        userId: user.id,
        operation: 'gmail_message_list',
        provider: 'gmail',
        outcome: 'success',
        listedMessageCount: pendingMessageIds.length,
        pageCount,
      });

      if (pendingMessageIds.length === 0) {
        yield { messages: [], matchedCount: 0, estimatedTotalCount, nextCursor: null };
        return;
      }

      while (pendingMessageIds.length > 0) {
        if (Date.now() - startedAt > MAX_IMPORT_DURATION_MS) {
          throw new AppError({
            code: 'MAILBOX_IMPORT_LIMIT_REACHED',
            message: 'Gmail import exceeded its time budget',
            publicMessage: 'This mailbox is too large to import safely in one operation.',
          });
        }
        const processingBatch = pendingMessageIds.slice(0, GMAIL_PROCESSING_BATCH_SIZE);
        const fetched = await Promise.all(processingBatch.map((messageId) => limit(async () => {
          if (pageFailure) throw pageFailure;
          await quotaPacer.waitFor(GMAIL_MESSAGE_GET_QUERY_UNITS);
          if (pageFailure) throw pageFailure;
          try {
            gmailRequestCount += 1;
            modeledQueryUnits += GMAIL_MESSAGE_GET_QUERY_UNITS;
            // A full response already contains the headers used by the safety preflight.
            // Reading metadata separately doubles messages.get quota without adding data.
            const message = decodeGmailMessage(await gmail.users.messages.get({
              userId: 'me', id: messageId, format: 'full',
            }, { retry: false }));
            let from = '';
            let to = '';
            let subject = '';
            let dateHeader = '';
            const authenticationHeaders: string[] = [];
            for (const header of message.payload?.headers ?? []) {
              const name = header.name.toLowerCase();
              if (name === 'from') from = header.value || '';
              if (name === 'to') to = header.value || '';
              if (name === 'subject') subject = header.value || '';
              if (name === 'date') dateHeader = header.value || '';
              if (name === 'authentication-results') authenticationHeaders.push(header.value || '');
            }
            const preflight = this.contentGuard.preflight({
              provider: 'gmail', from, to, subject, providerBytes: message.sizeEstimate, authenticationHeaders,
              allowForwardedReceipts: options?.safety?.allowForwardedReceipts ?? false,
            });
            if (!preflight.accepted) {
              this.logger.warn('Gmail message rejected by import safety policy', {
                userId: user.id, operation: 'gmail_message_fetch', provider: 'gmail',
                outcome: 'message_rejected', reason: preflight.reason,
              });
              return null;
            }
            const guarded = this.contentGuard.acceptBody(this.extractBody(message.payload), preflight);
            if (!guarded.accepted) {
              this.logger.warn('Gmail message rejected by import safety policy', {
                userId: user.id, operation: 'gmail_message_fetch', provider: 'gmail',
                outcome: 'message_rejected', reason: guarded.reason,
              });
              return null;
            }
            const internalTimestamp = Number(message.internalDate);
            const receivedAt = Number.isFinite(internalTimestamp)
              ? new Date(internalTimestamp)
              : dateHeader ? new Date(dateHeader) : undefined;
            return new MailboxMessage(
              user.id, from, to, guarded.body, subject, messageId,
              receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined,
            );
          } catch (error) {
            if (error instanceof AppError && error.code === 'GMAIL_PROVIDER_PAYLOAD_INVALID') return null;
            const failure = classifyGmailRequestFailure(error);
            if (failure.status === 404) return null;
            this.logger.warn(`Gmail message fetch failed (${failure.code}; status ${failure.status ?? 'unknown'}; ${failure.reason}) ${JSON.stringify(gmailFailureDiagnostics(error))}`, {
              userId: user.id, operation: 'gmail_message_fetch', provider: 'gmail',
              outcome: 'message_failure', errorCode: failure.code,
            });
            pageFailure = new AppError({
              code: failure.code,
              message: 'A Gmail message could not be loaded.',
              publicMessage: failure.publicMessage,
              details: {
                ...gmailFailureDiagnostics(error),
                gmailRequestCount,
                modeledQueryUnits,
                configuredQueryUnitsPerMinute: config.getGmailConfig().importQueryUnitsPerMinute,
              },
              cause: error,
            });
            throw pageFailure;
          }
        })));
        const messages = fetched.filter((message): message is MailboxMessage => message !== null);
        pendingMessageIds = pendingMessageIds.slice(processingBatch.length);
        const nextCursor = pendingMessageIds.length > 0
          ? encodeGmailBufferedCursor({
            pendingMessageIds,
            nextPageToken: null,
            searchQueryVersion,
            estimatedTotalCount,
          })
          : null;
        this.logger.debug('Gmail message page yielded', {
          userId: user.id, operation: 'gmail_message_fetch', provider: 'gmail', outcome: 'page_fetched',
          requestedCount: processingBatch.length, fetchedCount: messages.length, pageCount,
        });
        yield {
          messages,
          matchedCount: processingBatch.length,
          estimatedTotalCount,
          rejectedCount: processingBatch.length - messages.length,
          decodedBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0),
          nextCursor,
        };
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const failure = classifyGmailRequestFailure(error);
      this.logger.warn(`Gmail page fetch failed (${failure.code}; status ${failure.status ?? 'unknown'}; ${failure.reason}) ${JSON.stringify(gmailFailureDiagnostics(error))}`, {
        userId: user.id, operation: 'gmail_message_fetch', provider: 'gmail', errorCode: failure.code,
      });
      throw new AppError({
        code: failure.code, message: 'Failed to fetch a Gmail message page',
        publicMessage: failure.publicMessage,
        details: {
          ...gmailFailureDiagnostics(error),
          gmailRequestCount,
          modeledQueryUnits,
          configuredQueryUnitsPerMinute: config.getGmailConfig().importQueryUnitsPerMinute,
        },
        cause: error,
      });
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
    if (part.headers.some((header) => header.name.toLowerCase() === 'content-disposition' && /attachment/i.test(header.value))) return '';

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
    if (part.headers.some((header) => header.name.toLowerCase() === 'content-disposition' && /attachment/i.test(header.value))) return null;

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
