import { v4 as uuidv4 } from 'uuid';
import type { AnalyticsEventService } from '../analytics/AdminAnalyticsService';
import type { StructuredLogger } from '../core/StructuredLogger';
import type { AuthenticationActivityPort, AuthenticationMethod } from '../ports/AuthPorts';

/** Records privacy-bounded authentication analytics without making login depend on analytics availability. */
export class AuthenticationActivityService implements AuthenticationActivityPort {
  constructor(
    private readonly analytics: Pick<AnalyticsEventService, 'recordServerEvent'>,
    private readonly logger: StructuredLogger,
  ) {}

  async recordSuccess(
    userId: string,
    method: AuthenticationMethod,
    action: 'registered' | 'signed_in',
  ): Promise<void> {
    try {
      await this.analytics.recordServerEvent({
        eventId: uuidv4(),
        eventName: 'account_authenticated',
        userId,
        provider: method,
        properties: { method, action },
      });
    } catch (error) {
      this.logger.warn('Authentication activity could not be recorded', {
        operation: 'record_authentication_activity',
        outcome: 'failure',
        userId,
        provider: method,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      });
    }
  }
}
