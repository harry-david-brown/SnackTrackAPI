import { InteractionRequiredAuthError } from '@azure/msal-node';
import { AppError } from '../../core/errors';
import type { MailboxConnectionRepository } from '../data/MailboxConnectionRepository';
import type { MicrosoftMailboxConnection } from './MailboxConnection';
import {
  MICROSOFT_GRAPH_MAIL_SCOPES,
  type MicrosoftMailboxOAuthProvider,
} from './MicrosoftMailboxOAuthProvider';

export const isMicrosoftReconnectError = (error: unknown): boolean => {
  if (error instanceof InteractionRequiredAuthError) return true;
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return [record.errorCode, record.code, record.message]
    .map((value) => String(value ?? '').toLowerCase())
    .some(
      (value) =>
        value.includes('invalid_grant') ||
        value.includes('interaction_required') ||
        value.includes('consent_required') ||
        value.includes('login_required'),
    );
};

/** Acquires Graph tokens silently and durably rotates MSAL's encrypted cache. */
export class MicrosoftMailboxTokenService {
  constructor(
    private readonly oauth: MicrosoftMailboxOAuthProvider,
    private readonly connections: Pick<
      MailboxConnectionRepository,
      'updateMicrosoftTokenCache' | 'markMicrosoftReconnectRequired'
    >,
  ) {}

  async acquire(connection: MicrosoftMailboxConnection): Promise<string> {
    const client = this.oauth.createClientWithCache(connection.credentials.tokenCache);
    const account = await client
      .getTokenCache()
      .getAccountByHomeId(connection.credentials.homeAccountId);
    if (!account) {
      await this.connections.markMicrosoftReconnectRequired(connection.userId);
      throw this.reconnectError('Microsoft mailbox account was not found in the token cache');
    }
    try {
      const result = await client.acquireTokenSilent({
        account,
        scopes: [...MICROSOFT_GRAPH_MAIL_SCOPES],
      });
      await this.connections.updateMicrosoftTokenCache(
        connection.userId,
        client.getTokenCache().serialize(),
        result.expiresOn ?? null,
      );
      return result.accessToken;
    } catch (cause) {
      if (isMicrosoftReconnectError(cause)) {
        await this.connections.markMicrosoftReconnectRequired(connection.userId);
        throw this.reconnectError('Microsoft mailbox authorization requires interaction', cause);
      }
      throw new AppError({
        code: 'OUTLOOK_UNAVAILABLE',
        message: 'Microsoft mailbox access token acquisition failed',
        publicMessage: 'Outlook is temporarily unavailable. Please try again.',
        cause,
      });
    }
  }

  private reconnectError(message: string, cause?: unknown): AppError {
    return new AppError({
      code: 'OUTLOOK_RECONNECT_REQUIRED',
      message,
      publicMessage: 'Reconnect Outlook to continue.',
      cause,
    });
  }
}
