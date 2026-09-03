import type { MicrosoftSigningKey, MicrosoftSigningKeyProvider } from './MicrosoftIdentity';

interface FetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type MicrosoftJwksFetch = (url: string) => Promise<FetchResponse>;

export class MicrosoftSigningKeyError extends Error {
  constructor(readonly reason: 'unavailable' | 'not_found') {
    super(`Microsoft signing key ${reason}`);
    this.name = 'MicrosoftSigningKeyError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseSigningKey = (value: unknown): MicrosoftSigningKey | null => {
  if (!isRecord(value)) return null;
  if (
    value.kty !== 'RSA' ||
    typeof value.kid !== 'string' ||
    typeof value.n !== 'string' ||
    typeof value.e !== 'string' ||
    typeof value.issuer !== 'string'
  ) {
    return null;
  }
  if (value.use !== undefined && value.use !== 'sig') return null;
  if (value.alg !== undefined && value.alg !== 'RS256') return null;
  return {
    kty: 'RSA',
    kid: value.kid,
    use: value.use as 'sig' | undefined,
    alg: value.alg as 'RS256' | undefined,
    n: value.n,
    e: value.e,
    issuer: value.issuer,
  };
};

/** Bounded cache for Microsoft's tenant-independent v2 signing keys. */
export class MicrosoftJwksClient implements MicrosoftSigningKeyProvider {
  private keys = new Map<string, MicrosoftSigningKey>();
  private expiresAt = 0;

  constructor(
    private readonly jwksUri: string,
    private readonly fetcher: MicrosoftJwksFetch,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 60 * 60 * 1000,
  ) {}

  async getSigningKey(kid: string): Promise<MicrosoftSigningKey> {
    if (this.now() >= this.expiresAt || !this.keys.has(kid)) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new MicrosoftSigningKeyError('not_found');
    return key;
  }

  private async refresh(): Promise<void> {
    let response: FetchResponse;
    try {
      response = await this.fetcher(this.jwksUri);
    } catch {
      throw new MicrosoftSigningKeyError('unavailable');
    }
    if (!response.ok) throw new MicrosoftSigningKeyError('unavailable');
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MicrosoftSigningKeyError('unavailable');
    }
    const values = isRecord(payload) && Array.isArray(payload.keys) ? payload.keys : null;
    if (!values) throw new MicrosoftSigningKeyError('unavailable');
    const parsed = values
      .map(parseSigningKey)
      .filter((key): key is MicrosoftSigningKey => key !== null);
    if (parsed.length === 0) throw new MicrosoftSigningKeyError('unavailable');
    this.keys = new Map(parsed.map((key) => [key.kid, key]));
    this.expiresAt = this.now() + this.cacheTtlMs;
  }
}
