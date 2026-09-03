import { AppError } from '../../core/errors';
import type { StructuredLogger } from '../core/StructuredLogger';
import { silentStructuredLogger } from '../core/StructuredLogger';
import { MailboxMessage, type MailboxMessagePage } from '../ports/MailboxPorts';
import type { MailboxReadSafety } from '../ports/MailboxPorts';
import { MailboxContentGuard } from './MailboxContentGuard';
import pLimit from 'p-limit';
import type { MicrosoftMailboxConnection } from './MailboxConnection';
import type { MicrosoftMailboxTokenService } from './MicrosoftMailboxTokenService';

interface GraphResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  readonly body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}

type GraphFetch = (url: string, init: RequestInit) => Promise<GraphResponse>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const emailAddress = (value: unknown): string => {
  if (!isRecord(value) || !isRecord(value.emailAddress)) return '';
  return stringValue(value.emailAddress.address) ?? '';
};

const recipients = (value: unknown): string =>
  Array.isArray(value) ? value.map(emailAddress).filter(Boolean).join(', ') : '';

interface GraphCandidate {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject?: string;
  readonly receivedAt: Date;
}

interface GraphMessagePage {
  readonly candidates: GraphCandidate[];
  readonly matchedCount: number;
  readonly nextLink: string | null;
}

const decodePage = (value: unknown): GraphMessagePage => {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    throw new AppError({
      code: 'OUTLOOK_RESPONSE_INVALID',
      message: 'Microsoft Graph returned an invalid message page',
      publicMessage: 'Outlook returned an unexpected response. Please try again.',
    });
  }
  const candidates: GraphCandidate[] = [];
  for (const candidate of value.value) {
    if (!isRecord(candidate)) continue;
    const id = stringValue(candidate.id);
    const received = stringValue(candidate.receivedDateTime);
    if (!id || !received) continue;
    const receivedAt = new Date(received);
    if (Number.isNaN(receivedAt.getTime())) continue;
    candidates.push({ id, from: emailAddress(candidate.from), to: recipients(candidate.toRecipients), subject: stringValue(candidate.subject), receivedAt });
  }
  const nextLink = stringValue(value['@odata.nextLink']) ?? null;
  if (nextLink) {
    const next = new URL(nextLink);
    if (next.protocol !== 'https:' || next.hostname !== 'graph.microsoft.com') {
      throw new AppError({
        code: 'OUTLOOK_RESPONSE_INVALID',
        message: 'Microsoft Graph returned an unsafe pagination URL',
        publicMessage: 'Outlook returned an unexpected response. Please try again.',
      });
    }
  }
  return { candidates, matchedCount: value.value.length, nextLink };
};

const utcDate = (value: Date): string => value.toISOString().slice(0, 10);
const MAX_IMPORT_MESSAGES = 20_000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface GraphCursor {
  readonly version: 1;
  readonly scanEnd: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly nextLink: string | null;
  readonly matchedInWindow: number;
}

const encodeCursor = (cursor: GraphCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (value: string): GraphCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) throw new Error('unsupported cursor');
    const scanEnd = stringValue(parsed.scanEnd);
    const windowStart = stringValue(parsed.windowStart);
    const windowEnd = stringValue(parsed.windowEnd);
    const nextLink = parsed.nextLink === null ? null : stringValue(parsed.nextLink);
    const matchedInWindow = parsed.matchedInWindow;
    if (!scanEnd || !windowStart || !windowEnd || (parsed.nextLink !== null && !nextLink) ||
        typeof matchedInWindow !== 'number' || !Number.isInteger(matchedInWindow) || matchedInWindow < 0 ||
        [scanEnd, windowStart, windowEnd].some((date) => Number.isNaN(new Date(date).getTime()))) {
      throw new Error('invalid cursor');
    }
    if (nextLink) {
      const next = new URL(nextLink);
      if (next.protocol !== 'https:' || next.hostname !== 'graph.microsoft.com') throw new Error('unsafe cursor');
    }
    return { version: 1, scanEnd, windowStart, windowEnd, nextLink: nextLink ?? null, matchedInWindow };
  } catch (cause) {
    throw new AppError({
      code: 'IMPORT_CHECKPOINT_INVALID',
      message: 'Invalid Outlook pagination checkpoint',
      publicMessage: 'This import could not be resumed safely. Start a new import.',
      cause,
    });
  }
};

/** Microsoft Graph adapter that returns normalized HTML mailbox messages. */
export class MicrosoftGraphMailboxClient {
  private readonly contentGuard = new MailboxContentGuard();
  constructor(
    private readonly tokens: Pick<MicrosoftMailboxTokenService, 'acquire'>,
    private readonly fetcher: GraphFetch = fetch,
    private readonly logger: StructuredLogger = silentStructuredLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async validateConnection(connection: MicrosoftMailboxConnection): Promise<void> {
    const token = await this.tokens.acquire(connection);
    await this.request('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id', token);
  }

  async getEmails(
    connection: MicrosoftMailboxConnection,
    options?: { after?: Date; safety?: MailboxReadSafety },
  ): Promise<MailboxMessage[]> {
    const byId = new Map<string, MailboxMessage>();
    for await (const page of this.getEmailPages(connection, options)) {
      for (const message of page.messages) {
        if (message.providerMessageId) byId.set(message.providerMessageId, message);
      }
      if (byId.size > MAX_IMPORT_MESSAGES) {
        throw new AppError({
          code: 'MAILBOX_IMPORT_LIMIT_REACHED',
          message: 'Outlook import exceeded its message budget',
          publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
        });
      }
    }
    return [...byId.values()].sort(
      (left, right) => (left.receivedAt?.getTime() ?? 0) - (right.receivedAt?.getTime() ?? 0),
    );
  }

  async *getEmailPages(
    connection: MicrosoftMailboxConnection,
    options?: { after?: Date; cursor?: string; safety?: MailboxReadSafety },
  ): AsyncIterable<MailboxMessagePage> {
    const token = await this.tokens.acquire(connection);
    let cursor = options?.cursor
      ? decodeCursor(options.cursor)
      : this.initialCursor(options?.after);
    let totalMatched = 0;
    while (true) {
      const windowStart = new Date(cursor.windowStart);
      const windowEnd = new Date(cursor.windowEnd);
      const requestUrl = cursor.nextLink ?? this.searchUrl(windowStart, windowEnd, options?.safety?.allowForwardedReceipts ?? false);
      const page = decodePage(await this.request(requestUrl, token, 2 * 1024 * 1024));
      const limit = pLimit(5);
      const fetched = await Promise.all(page.candidates.map((candidate) => limit(async () => {
        if (candidate.receivedAt.getTime() < windowStart.getTime() || candidate.receivedAt.getTime() >= windowEnd.getTime()) return null;
        const senderPreflight = this.contentGuard.preflight({
          provider: 'microsoft', from: candidate.from, to: candidate.to, subject: candidate.subject,
          allowForwardedReceipts: options?.safety?.allowForwardedReceipts ?? false,
        });
        if (!senderPreflight.accepted) return null;
        try {
          const detail = await this.request(this.messageUrl(candidate.id), token, 2 * 1024 * 1024);
          return this.decodeMessageDetail(detail, candidate, connection.userId, options?.safety?.allowForwardedReceipts ?? false);
        } catch (error) {
          this.logger.warn('Outlook message rejected or unavailable', {
            userId: connection.userId, operation: 'outlook_message_fetch', provider: 'microsoft',
            outcome: 'message_failure', error,
          });
          if (error instanceof AppError && (error.code === 'MAILBOX_MESSAGE_TOO_LARGE' || error.code === 'OUTLOOK_MESSAGE_UNAVAILABLE')) return null;
          throw error;
        }
      })));
      const messages = fetched.filter((message): message is MailboxMessage => message !== null);
      const matchedInWindow = cursor.matchedInWindow + page.matchedCount;
      totalMatched += page.matchedCount;
      if (matchedInWindow >= 1000 && !page.nextLink) {
        throw new AppError({
          code: 'OUTLOOK_RESULT_LIMIT',
          message: 'Microsoft Graph mailbox search reached its result cap for a 30-day window',
          publicMessage: 'This Outlook mailbox has too many matching messages in a short period to import safely.',
        });
      }
      if (totalMatched > MAX_IMPORT_MESSAGES) {
        throw new AppError({
          code: 'MAILBOX_IMPORT_LIMIT_REACHED',
          message: 'Outlook import exceeded its message budget',
          publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
        });
      }
      const scanEnd = new Date(cursor.scanEnd);
      let nextCursor: string | null;
      if (page.nextLink) {
        nextCursor = encodeCursor({ ...cursor, nextLink: page.nextLink, matchedInWindow });
      } else if (windowEnd < scanEnd) {
        const nextEnd = new Date(Math.min(windowEnd.getTime() + WINDOW_MS, scanEnd.getTime()));
        nextCursor = encodeCursor({
          version: 1,
          scanEnd: cursor.scanEnd,
          windowStart: windowEnd.toISOString(),
          windowEnd: nextEnd.toISOString(),
          nextLink: null,
          matchedInWindow: 0,
        });
      } else {
        nextCursor = null;
      }
      yield {
        messages,
        matchedCount: page.matchedCount,
        rejectedCount: page.matchedCount - messages.length,
        decodedBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0),
        nextCursor,
      };
      if (!nextCursor) return;
      cursor = decodeCursor(nextCursor);
    }
  }

  async hasUberExportReadyEmail(
    connection: MicrosoftMailboxConnection,
    requestedAt: string,
  ): Promise<boolean> {
    const after = new Date(requestedAt);
    if (Number.isNaN(after.getTime())) return false;
    const messages = await this.getEmails(connection, { after });
    return messages.some((message) => {
      const from = message.from.toLowerCase();
      const subject = (message.subject ?? '').toLowerCase();
      const body = message.body.toLowerCase();
      return (
        /@(?:[a-z0-9-]+\.)?(?:uber|ubereats)\.com\b/i.test(from) &&
        (subject.includes('your uber data is ready for download') ||
          body.includes('your uber data is now ready') ||
          body.includes('ready for you to download'))
      );
    });
  }

  private initialCursor(after?: Date): GraphCursor {
    const end = this.now();
    const configuredStart = after ? new Date(after) : new Date(Date.UTC(2009, 0, 1));
    const start = configuredStart < end ? configuredStart : new Date(end.getTime() - 60_000);
    return {
      version: 1,
      scanEnd: end.toISOString(),
      windowStart: start.toISOString(),
      windowEnd: new Date(Math.min(start.getTime() + WINDOW_MS, end.getTime())).toISOString(),
      nextLink: null,
      matchedInWindow: 0,
    };
  }

  private searchUrl(start: Date, end: Date, allowForwardedReceipts: boolean): string {
    const search = [
      allowForwardedReceipts
        ? '((from:uber.com OR from:ubereats.com OR from:doordash.com) OR (subject:Uber OR subject:DoorDash))'
        : '(from:uber.com OR from:ubereats.com OR from:noreply@uber.com OR from:noreply@ubereats.com OR from:doordash.com)',
      `received>=${utcDate(start)}`,
      `received<=${utcDate(end)}`,
    ].join(' AND ');
    const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
    url.searchParams.set('$search', `"${search}"`);
    url.searchParams.set(
      '$select',
      'id,internetMessageId,receivedDateTime,from,toRecipients,subject',
    );
    url.searchParams.set('$top', '20');

    return url.toString();
  }

  private messageUrl(messageId: string): string {
    const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('$select', 'id,body,internetMessageHeaders');
    return url.toString();
  }

  private decodeMessageDetail(value: unknown, candidate: GraphCandidate, userId: string, allowForwardedReceipts: boolean): MailboxMessage | null {
    if (!isRecord(value)) return null;
    const body = isRecord(value.body) ? stringValue(value.body.content) : undefined;
    if (!body) return null;
    const headers = Array.isArray(value.internetMessageHeaders) ? value.internetMessageHeaders : [];
    const authenticationHeaders = headers.flatMap((header) => {
      if (!isRecord(header) || stringValue(header.name)?.toLowerCase() !== 'authentication-results') return [];
      const headerValue = stringValue(header.value);
      return headerValue ? [headerValue] : [];
    });
    const preflight = this.contentGuard.preflight({
      provider: 'microsoft', from: candidate.from, to: candidate.to, subject: candidate.subject,
      providerBytes: Buffer.byteLength(JSON.stringify(value)),
      authenticationHeaders, allowForwardedReceipts,
    });
    const guarded = this.contentGuard.acceptBody(body, preflight);
    if (!guarded.accepted) {
      this.logger.warn('Outlook message rejected by import safety policy', {
        userId, operation: 'outlook_message_fetch', provider: 'microsoft',
        outcome: 'message_rejected', reason: guarded.reason,
      });
      return null;
    }
    return new MailboxMessage(userId, candidate.from, candidate.to, guarded.body, candidate.subject, candidate.id, candidate.receivedAt, 'microsoft');
  }

  private async readBoundedJson(response: GraphResponse, maximumBytes: number): Promise<unknown> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new AppError({ code: 'MAILBOX_MESSAGE_TOO_LARGE', message: 'Microsoft Graph response exceeds the safe size limit.' });
    }
    if (!response.body) {
      const value = await response.json();
      if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes) throw new AppError({ code: 'MAILBOX_MESSAGE_TOO_LARGE', message: 'Microsoft Graph response exceeds the safe size limit.' });
      return value;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      size += item.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError({ code: 'MAILBOX_MESSAGE_TOO_LARGE', message: 'Microsoft Graph response exceeds the safe size limit.' });
      }
      chunks.push(item.value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    try { return JSON.parse(body) as unknown; }
    catch (cause) { throw new AppError({ code: 'OUTLOOK_RESPONSE_INVALID', message: 'Microsoft Graph returned invalid JSON.', cause }); }
  }

  private async request(url: string, token: string, maximumBytes = 2 * 1024 * 1024): Promise<unknown> {
    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let response: GraphResponse;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: 'outlook.body-content-type="html", IdType="ImmutableId"',
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (cause) {
        if (attempt < maximumAttempts) {
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        throw new AppError({
          code: 'OUTLOOK_UNAVAILABLE',
          message: 'Microsoft Graph request failed',
          publicMessage: 'Outlook is temporarily unavailable. Please try again.',
          cause,
        });
      }
      if (response.ok) return this.readBoundedJson(response, maximumBytes);
      if ([429, 503, 504].includes(response.status) && attempt < maximumAttempts) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter)
          ? Math.min(60_000, Math.max(0, retryAfter * 1000))
          : 250 * 2 ** (attempt - 1);
        this.logger.warn('Microsoft Graph request throttled or unavailable', {
          operation: 'outlook_message_fetch',
          provider: 'microsoft',
          outcome: 'retrying',
          status: response.status,
          attempt,
        });
        await this.sleep(delay);
        continue;
      }
      throw new AppError({
        code:
          response.status === 401 || response.status === 403
            ? 'OUTLOOK_RECONNECT_REQUIRED'
            : response.status === 404
              ? 'OUTLOOK_MESSAGE_UNAVAILABLE'
            : 'OUTLOOK_FETCH_FAILED',
        message: `Microsoft Graph message request failed with status ${response.status}`,
        publicMessage:
          response.status === 401 || response.status === 403
            ? 'Reconnect Outlook to continue.'
            : 'Outlook messages could not be loaded.',
      });
    }
    throw new Error('Unreachable Microsoft Graph retry state');
  }
}
