import type { ImportLifecycleRepository } from '../data/ImportLifecycleRepository';
import type { MailboxConnectionRepository } from '../data/MailboxConnectionRepository';
import type { MicrosoftGraphMailboxClient } from './MicrosoftGraphMailboxClient';
import type {
  MicrosoftMailboxConnection,
  MicrosoftMailboxConnectionStatus,
} from './MailboxConnection';
import { isMicrosoftReconnectError } from './MicrosoftMailboxTokenService';

export type MicrosoftMailboxHealth =
  'disconnected' | 'valid' | 'reconnect_required' | 'unavailable';

export interface MicrosoftMailboxHealthResult {
  readonly status: MicrosoftMailboxHealth;
  readonly validatedAt: string | null;
}

const hasMailReadScope = (scope: string): boolean => {
  const normalized = scope.toLowerCase();
  return normalized === 'mail.read' || normalized.endsWith('/mail.read');
};
const VALIDATION_TTL_MS = 15 * 60 * 1000;

export class MicrosoftMailboxConnectionHealthService {
  private readonly successfulValidations = new Map<string, number>();

  constructor(
    private readonly graph: Pick<MicrosoftGraphMailboxClient, 'validateConnection'>,
    private readonly connections: Pick<
      MailboxConnectionRepository,
      'findMicrosoft' | 'markMicrosoftReconnectRequired'
    >,
    private readonly lifecycle: Pick<ImportLifecycleRepository, 'markTrackingReconnectRequired'>,
  ) {}

  invalidate(userId: string): void {
    this.successfulValidations.delete(userId);
  }

  async validate(
    userId: string,
    force = false,
  ): Promise<{
    connection: MicrosoftMailboxConnection | undefined;
    health: MicrosoftMailboxHealthResult;
  }> {
    const connection = await this.connections.findMicrosoft(userId);
    if (!connection) {
      return { connection: undefined, health: { status: 'disconnected', validatedAt: null } };
    }
    if (connection.state === 'reconnect_required') {
      return { connection, health: { status: 'reconnect_required', validatedAt: null } };
    }
    const cachedAt = this.successfulValidations.get(userId);
    if (!force && cachedAt && Date.now() - cachedAt < VALIDATION_TTL_MS) {
      return {
        connection,
        health: { status: 'valid', validatedAt: new Date(cachedAt).toISOString() },
      };
    }
    try {
      await this.graph.validateConnection(connection);
      const validatedAt = Date.now();
      this.successfulValidations.set(userId, validatedAt);
      return {
        connection: (await this.connections.findMicrosoft(userId)) ?? connection,
        health: { status: 'valid', validatedAt: new Date(validatedAt).toISOString() },
      };
    } catch (error) {
      this.invalidate(userId);
      const reconnect =
        isMicrosoftReconnectError(error) ||
        (error &&
          typeof error === 'object' &&
          (error as Record<string, unknown>).code === 'OUTLOOK_RECONNECT_REQUIRED');
      if (reconnect) {
        await this.connections.markMicrosoftReconnectRequired(userId);
        await this.lifecycle.markTrackingReconnectRequired(userId);
        return {
          connection: (await this.connections.findMicrosoft(userId)) ?? connection,
          health: { status: 'reconnect_required', validatedAt: null },
        };
      }
      return { connection, health: { status: 'unavailable', validatedAt: null } };
    }
  }

  buildStatus(
    connection: MicrosoftMailboxConnection | undefined,
    health: MicrosoftMailboxHealthResult,
  ): MicrosoftMailboxConnectionStatus {
    const hasRequiredScope = Boolean(connection?.scopes.some(hasMailReadScope));
    const connected = Boolean(connection);
    const needsReconnect = health.status === 'reconnect_required';
    const canImport = connected && hasRequiredScope && !needsReconnect;
    return {
      provider: 'microsoft',
      connected,
      canImport,
      needsReconnect,
      email: connection?.email ?? null,
      connectionMode: connection?.connectionMode ?? 'none',
      scopes: connection?.scopes ?? [],
      hasRequiredScope,
      expiresAt: connection?.tokenExpiresAt ?? null,
      connectionHealth: health.status,
      lastValidatedAt: health.validatedAt,
      statusMessage: needsReconnect
        ? 'Outlook needs to be reconnected before imports can run.'
        : health.status === 'unavailable'
          ? 'Outlook could not be verified right now. Try again shortly.'
          : connected
            ? 'Outlook is connected with durable read-only access.'
            : 'Connect Outlook to import receipts.',
    };
  }
}
