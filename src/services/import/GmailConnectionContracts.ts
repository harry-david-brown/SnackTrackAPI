export const GMAIL_CONNECTION_PURPOSES = [
  'receipt_import',
  'export_ready_alerts',
  'ongoing_tracking',
  'connection_recovery',
  'manage_connection',
] as const;
export type GmailConnectionPurpose = (typeof GMAIL_CONNECTION_PURPOSES)[number];

export const GMAIL_CONNECTION_MODES = ['temporary', 'offline', 'none'] as const;
export type GmailConnectionMode = (typeof GMAIL_CONNECTION_MODES)[number];
export const isGmailConnectionMode = (value: unknown): value is GmailConnectionMode =>
  typeof value === 'string' && GMAIL_CONNECTION_MODES.some((mode) => mode === value);

export interface GmailOAuthState {
  readonly userId: string;
  readonly redirectUri: string;
  readonly purpose: GmailConnectionPurpose;
}

export interface GmailOAuthGrant {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiryDate: Date;
  readonly email: string;
  readonly scopes: readonly string[];
}

export interface GmailOAuthPort {
  createAuthorizationUrl(state: GmailOAuthState): string;
  verifyState(state: string): GmailOAuthState;
  exchangeAuthorizationCode(code: string): Promise<GmailOAuthGrant>;
}
