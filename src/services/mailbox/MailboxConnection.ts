export const MAILBOX_PROVIDERS = ['gmail', 'microsoft'] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export type MailboxConnectionMode = 'temporary' | 'offline';
export type MailboxConnectionState = 'connected' | 'reconnect_required';

export interface MicrosoftMailboxCredentials {
  readonly tokenCache: string;
  readonly homeAccountId: string;
}

export interface MicrosoftMailboxConnection {
  readonly userId: string;
  readonly provider: 'microsoft';
  readonly providerAccountId: string;
  readonly email: string;
  readonly scopes: readonly string[];
  readonly connectionMode: MailboxConnectionMode;
  readonly state: MailboxConnectionState;
  readonly tokenExpiresAt: string | null;
  readonly credentials: MicrosoftMailboxCredentials;
}

export interface MailboxImportState {
  readonly provider: 'microsoft';
  readonly status: 'never_started' | 'importing' | 'completed' | 'failed';
  readonly updatedAt: string | null;
  readonly importedCount: number;
  readonly errorCode: string | null;
  readonly baselineCompletedAt: string | null;
}

export interface MicrosoftMailboxConnectionStatus {
  readonly provider: 'microsoft';
  readonly connected: boolean;
  readonly canImport: boolean;
  readonly needsReconnect: boolean;
  readonly email: string | null;
  readonly connectionMode: MailboxConnectionMode | 'none';
  readonly scopes: readonly string[];
  readonly hasRequiredScope: boolean;
  readonly expiresAt: string | null;
  readonly connectionHealth: 'disconnected' | 'valid' | 'reconnect_required' | 'unavailable';
  readonly lastValidatedAt: string | null;
  readonly statusMessage: string;
}
