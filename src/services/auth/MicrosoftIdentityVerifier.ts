import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'crypto';
import type { JsonWebKey as CryptoJsonWebKey } from 'crypto';
import type {
  MicrosoftIdentityVerifierPort,
  MicrosoftSigningKey,
  MicrosoftSigningKeyProvider,
  VerifiedMicrosoftIdentity,
} from './MicrosoftIdentity';
import { MicrosoftSigningKeyError } from './MicrosoftJwksClient';

export type MicrosoftIdentityVerificationReason =
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_active'
  | 'nonce'
  | 'identity';

export class MicrosoftIdentityVerificationError extends Error {
  constructor(readonly reason: MicrosoftIdentityVerificationReason) {
    super(`Microsoft identity token validation failed: ${reason}`);
    this.name = 'MicrosoftIdentityVerificationError';
  }
}

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secureEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};
const decodeJsonSegment = (value: string): Record<string, unknown> => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isRecord(decoded)) throw new Error('not an object');
    return decoded;
  } catch {
    throw new MicrosoftIdentityVerificationError('malformed');
  }
};
const validEmail = (value: unknown): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length <= 320 && EMAIL.test(normalized) ? normalized : undefined;
};
const issuerForTenant = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/v2.0`;
const validateSigningKeyIssuer = (
  key: MicrosoftSigningKey,
  tenantId: string,
  tokenIssuer: string,
): void => {
  if (key.issuer.replace(/\{tenantid\}/gi, tenantId).toLowerCase() !== tokenIssuer) {
    throw new MicrosoftIdentityVerificationError('issuer');
  }
};

/** Validates Microsoft v2 ID tokens without trusting client-supplied identity data. */
export class MicrosoftIdentityVerifier implements MicrosoftIdentityVerifierPort {
  constructor(
    private readonly clientId: string,
    private readonly signingKeys: MicrosoftSigningKeyProvider,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
    private readonly clockSkewSeconds = 60,
  ) {}

  async verify(
    identityToken: string,
    expectedNonceHash: string,
  ): Promise<VerifiedMicrosoftIdentity> {
    if (!identityToken || identityToken.length > 20_000 || !expectedNonceHash) {
      throw new MicrosoftIdentityVerificationError('malformed');
    }
    const segments = identityToken.split('.');
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw new MicrosoftIdentityVerificationError('malformed');
    }
    const header = decodeJsonSegment(segments[0]);
    const claims = decodeJsonSegment(segments[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new MicrosoftIdentityVerificationError('algorithm');
    }

    let key: MicrosoftSigningKey;
    try {
      key = await this.signingKeys.getSigningKey(header.kid);
    } catch (error) {
      if (error instanceof MicrosoftSigningKeyError && error.reason === 'not_found') {
        throw new MicrosoftIdentityVerificationError('signature');
      }
      throw error;
    }
    try {
      const publicKey = createPublicKey({
        key: { kty: key.kty, n: key.n, e: key.e } as CryptoJsonWebKey,
        format: 'jwk',
      });
      if (
        !verifySignature(
          'RSA-SHA256',
          Buffer.from(`${segments[0]}.${segments[1]}`),
          publicKey,
          Buffer.from(segments[2], 'base64url'),
        )
      ) {
        throw new MicrosoftIdentityVerificationError('signature');
      }
    } catch (error) {
      if (error instanceof MicrosoftIdentityVerificationError) throw error;
      throw new MicrosoftIdentityVerificationError('signature');
    }

    const tenantId = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
    const issuer = typeof claims.iss === 'string' ? claims.iss.toLowerCase() : '';
    if (!GUID.test(tenantId) || issuer !== issuerForTenant(tenantId) || claims.ver !== '2.0') {
      throw new MicrosoftIdentityVerificationError('issuer');
    }
    validateSigningKeyIssuer(key, tenantId, issuer);
    if (typeof claims.aud !== 'string' || claims.aud.toLowerCase() !== this.clientId.toLowerCase()) {
      throw new MicrosoftIdentityVerificationError('audience');
    }

    const now = this.nowSeconds();
    if (typeof claims.exp !== 'number' || claims.exp <= now - this.clockSkewSeconds) {
      throw new MicrosoftIdentityVerificationError('expired');
    }
    if (
      (typeof claims.nbf === 'number' && claims.nbf > now + this.clockSkewSeconds) ||
      (typeof claims.iat === 'number' && claims.iat > now + this.clockSkewSeconds)
    ) {
      throw new MicrosoftIdentityVerificationError('not_active');
    }
    if (typeof claims.nonce !== 'string' || !secureEqual(hash(claims.nonce), expectedNonceHash)) {
      throw new MicrosoftIdentityVerificationError('nonce');
    }

    const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    const objectId =
      typeof claims.oid === 'string' && GUID.test(claims.oid) ? claims.oid.toLowerCase() : null;
    if (!subject || subject.length > 1024) throw new MicrosoftIdentityVerificationError('identity');
    const verifiedPrimaryEmail = validEmail(claims.verified_primary_email);
    const claimedEmail = validEmail(claims.email);
    const trustedEmail =
      verifiedPrimaryEmail ?? (claims.xms_edov === true ? claimedEmail : undefined);
    const email = trustedEmail ?? claimedEmail;
    const suggestedEmail = email ?? validEmail(claims.preferred_username);
    return {
      providerUserId: objectId
        ? `${tenantId}:${objectId}`
        : `${tenantId}:sub:${hash(subject)}`,
      email,
      suggestedEmail,
      emailVerified: Boolean(trustedEmail),
    };
  }
}
