import type { User } from '../../models/User';
import type { MailboxProvider } from '../mailbox/MailboxConnection';

/** Provider-neutral message presented to the shared receipt-import pipeline. */
export class MailboxMessage {
  constructor(
    public userId: string,
    public from: string,
    public to: string,
    public body: string,
    public subject?: string,
    public providerMessageId?: string,
    public receivedAt?: Date,
    public provider: MailboxProvider = 'gmail',
  ) {}
}

export interface MailboxMessagePage {
  readonly messages: readonly MailboxMessage[];
  /** Opaque resume cursor for the next durable processing batch; null means complete. */
  readonly nextCursor: string | null;
  readonly matchedCount: number;
  readonly rejectedCount?: number;
  readonly decodedBytes?: number;
}

export interface MailboxReadSafety {
  readonly allowForwardedReceipts: boolean;
}

export interface MailboxClient {
  getEmails(user: User, options?: { after?: Date; safety?: MailboxReadSafety }): Promise<MailboxMessage[]>;
  getEmailPages(
    user: User,
    options?: { after?: Date; cursor?: string; safety?: MailboxReadSafety },
  ): AsyncIterable<MailboxMessagePage>;
}

export interface EmailDebugCapturePort {
  capture(event: string, metadata: Readonly<Record<string, unknown>>): Promise<void>;
}
