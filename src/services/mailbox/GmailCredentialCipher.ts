import type { GmailCredentialCipherPort } from '../ports/GmailCredentialCipherPort';
import { MailboxSecretCipher } from './MailboxSecretCipher';

/** Bind each authenticated envelope to its owner and token purpose. */
export class GmailCredentialCipher implements GmailCredentialCipherPort {
  static readonly prefix = 'gmail.v1.';
  constructor(private readonly cipher: MailboxSecretCipher) {}

  encrypt(userId: string, kind: 'access' | 'refresh', token: string): string {
    return GmailCredentialCipher.prefix + this.cipher.encrypt(JSON.stringify({ userId, kind, token }));
  }

  decrypt(userId: string, kind: 'access' | 'refresh', envelope: string): string {
    if (!envelope.startsWith(GmailCredentialCipher.prefix)) {
      throw new Error('Gmail credential migration is required');
    }
    const value: unknown = JSON.parse(this.cipher.decrypt(envelope.slice(GmailCredentialCipher.prefix.length)));
    if (!value || typeof value !== 'object' || !('userId' in value) || value.userId !== userId ||
        !('kind' in value) || value.kind !== kind || !('token' in value) || typeof value.token !== 'string') {
      throw new Error('Invalid Gmail credential envelope');
    }
    return value.token;
  }
}
