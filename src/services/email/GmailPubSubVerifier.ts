import { OAuth2Client } from 'google-auth-library';
import { AuthenticationError } from '../../core/errors';

export interface GmailPubSubConfig {
  readonly audience?: string;
  readonly serviceAccountEmail?: string;
  readonly subscription?: string;
}

/** Verifies Google-signed OIDC tokens used by the one configured push subscription. */
export class GmailPubSubVerifier {
  constructor(
    private readonly config: GmailPubSubConfig,
    private readonly verifier: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client(),
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.audience && this.config.serviceAccountEmail && this.config.subscription);
  }

  expectedSubscription(): string | undefined {
    return this.config.subscription;
  }

  async verify(authorization: string | undefined): Promise<void> {
    if (!this.isConfigured()) {
      throw new AuthenticationError('Gmail push delivery is not configured');
    }
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._-]{100,4096})$/);
    if (!match) throw new AuthenticationError('Invalid Gmail push authorization');
    try {
      const ticket = await this.verifier.verifyIdToken({
        idToken: match[1],
        audience: this.config.audience!,
      });
      const payload = ticket.getPayload();
      if (
        payload?.email_verified !== true ||
        payload.email?.toLowerCase() !== this.config.serviceAccountEmail!.toLowerCase()
      ) {
        throw new Error('Unexpected push identity');
      }
    } catch (cause) {
      throw new AuthenticationError('Invalid Gmail push authorization', 'AUTHENTICATION_REQUIRED');
    }
  }
}
