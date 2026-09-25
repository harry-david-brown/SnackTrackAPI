import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** AES-GCM envelope used for persisted provider token caches and OAuth state. */
export class MailboxSecretCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) throw new Error('Mailbox token encryption key is too short');
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    const [version, encodedIv, encodedTag, encodedCiphertext] = parts;
    if (parts.length !== 4 || version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
      throw new Error('Invalid encrypted mailbox secret');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(encodedIv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Mailbox secret could not be decrypted');
    }
  }
}
