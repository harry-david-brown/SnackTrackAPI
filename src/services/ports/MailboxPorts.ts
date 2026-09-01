import type { User } from '../../models/User';

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
  ) {}
}

export interface MailboxClient {
  getEmails(user: User, options?: { after?: Date }): Promise<MailboxMessage[]>;
}

export interface EmailDebugCapturePort {
  capture(event: string, metadata: Readonly<Record<string, unknown>>): Promise<void>;
}
