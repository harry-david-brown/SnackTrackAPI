import type { User } from '../../models/User';

export type GmailPushReceiptResult =
  | { readonly outcome: 'accepted'; readonly userId: string }
  | { readonly outcome: 'duplicate' | 'unknown_mailbox' | 'ambiguous_mailbox' };

export interface GmailPushDispatch {
  readonly userId: string;
  readonly historyId: string | null;
  readonly notificationCount: number;
  readonly failureCount: number;
}

export interface GmailWatchCandidate {
  readonly userId: string;
}

export interface GmailPushStatePort {
  recordNotification(input: {
    messageId: string;
    emailAddress: string;
    historyId: string;
    debounceSeconds: number;
  }): Promise<GmailPushReceiptResult>;
  claimDue(limit?: number): Promise<GmailPushDispatch[]>;
  markDispatched(userId: string, historyId: string | null, notificationCount: number): Promise<void>;
  releaseDispatch(userId: string, errorCode: string): Promise<void>;
  markProcessed(userId: string): Promise<void>;
  listWatchCandidates(limit?: number): Promise<GmailWatchCandidate[]>;
  hasHealthyWatch(userId: string): Promise<boolean>;
  saveWatch(userId: string, historyId: string, expiration: Date): Promise<void>;
  recordWatchFailure(userId: string, errorCode: string): Promise<void>;
  clearWatch(userId: string): Promise<void>;
}

export interface GmailWatchClientPort {
  startMailboxWatch(user: User, topicName: string): Promise<{ historyId: string; expiration: Date }>;
  stopMailboxWatch(user: User): Promise<void>;
}

export interface GmailPushJobPort {
  create(input: {
    userId: string;
    kind: 'gmail_push_tracking';
    trigger: 'scheduler';
    journeyContext: 'routine';
    idempotencyKey: string;
    initialCheckpoint: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}
