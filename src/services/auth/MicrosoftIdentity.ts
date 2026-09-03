export interface VerifiedMicrosoftIdentity {
  readonly providerUserId: string;
  readonly email?: string;
  readonly suggestedEmail?: string;
  readonly emailVerified: boolean;
}

export interface MicrosoftIdentityVerifierPort {
  verify(identityToken: string, expectedNonceHash: string): Promise<VerifiedMicrosoftIdentity>;
}

export interface MicrosoftSigningKey {
  readonly kty: 'RSA';
  readonly kid: string;
  readonly use?: 'sig';
  readonly alg?: 'RS256';
  readonly n: string;
  readonly e: string;
  readonly issuer: string;
}

export interface MicrosoftSigningKeyProvider {
  getSigningKey(kid: string): Promise<MicrosoftSigningKey>;
}
