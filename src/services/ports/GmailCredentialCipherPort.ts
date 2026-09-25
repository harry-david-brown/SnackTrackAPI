export interface GmailCredentialCipherPort {
  encrypt(userId: string, kind: 'access' | 'refresh', token: string): string;
  decrypt(userId: string, kind: 'access' | 'refresh', envelope: string): string;
}
