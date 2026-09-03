const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const {
  MicrosoftIdentityVerifier,
  MicrosoftIdentityVerificationError,
} = require('../dist/services/auth/MicrosoftIdentityVerifier');
const { MicrosoftSigningKeyError } = require('../dist/services/auth/MicrosoftJwksClient');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const ORG_TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const OBJECT_ID = '12345678-90ab-cdef-1234-567890abcdef';
const NOW = 2_000_000_000;
const NONCE = 'nonce-with-at-least-16-characters';
const NONCE_HASH = createHash('sha256').update(NONCE).digest('hex');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (overrides = {}, headerOverrides = {}) => {
  const claims = {
    ver: '2.0',
    iss: `https://login.microsoftonline.com/${ORG_TENANT}/v2.0`,
    aud: CLIENT_ID,
    tid: ORG_TENANT,
    sub: 'stable-pairwise-subject',
    oid: OBJECT_ID,
    nonce: NONCE,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    email: 'Person@Example.com',
    xms_edov: true,
    ...overrides,
  };
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key', ...headerOverrides };
  const unsigned = `${encode(header)}.${encode(claims)}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
};
const verifier = (issuer = 'https://login.microsoftonline.com/{tenantid}/v2.0') =>
  new MicrosoftIdentityVerifier(
    CLIENT_ID,
    {
      async getSigningKey(kid) {
        return { kty: 'RSA', kid, n: publicJwk.n, e: publicJwk.e, issuer };
      },
    },
    () => NOW,
    60,
  );
const rejectsFor = async (value, reason, nonceHash = NONCE_HASH, instance = verifier()) => {
  await assert.rejects(
    instance.verify(value, nonceHash),
    (error) => error instanceof MicrosoftIdentityVerificationError && error.reason === reason,
  );
};

test('accepts signed organizational and personal Microsoft v2 ID tokens', async () => {
  const organizational = await verifier().verify(token(), NONCE_HASH);
  assert.equal(organizational.providerUserId, `${ORG_TENANT}:${OBJECT_ID}`);
  assert.equal(organizational.email, 'person@example.com');
  assert.equal(organizational.emailVerified, true);
  const personal = await verifier().verify(
    token({
      tid: PERSONAL_TENANT,
      iss: `https://login.microsoftonline.com/${PERSONAL_TENANT}/v2.0`,
    }),
    NONCE_HASH,
  );
  assert.equal(personal.providerUserId, `${PERSONAL_TENANT}:${OBJECT_ID}`);
});

test('treats mutable email claims only as suggested until xms_edov is true', async () => {
  const identity = await verifier().verify(
    token({ email: undefined, preferred_username: 'Alias@Example.com', xms_edov: false }),
    NONCE_HASH,
  );
  assert.equal(identity.email, undefined);
  assert.equal(identity.suggestedEmail, 'alias@example.com');
  assert.equal(identity.emailVerified, false);
});

test('trusts verified_primary_email and prefers it over mutable email claims', async () => {
  const identity = await verifier().verify(
    token({
      verified_primary_email: 'Verified@Example.com',
      email: 'Mutable@Example.com',
      preferred_username: 'Alias@Example.com',
      xms_edov: false,
    }),
    NONCE_HASH,
  );
  assert.equal(identity.email, 'verified@example.com');
  assert.equal(identity.suggestedEmail, 'verified@example.com');
  assert.equal(identity.emailVerified, true);
});

test('does not bypass verification for a malformed verified_primary_email claim', async () => {
  const identity = await verifier().verify(
    token({
      verified_primary_email: 'not-an-email',
      email: undefined,
      preferred_username: 'Alias@Example.com',
      xms_edov: false,
    }),
    NONCE_HASH,
  );
  assert.equal(identity.email, undefined);
  assert.equal(identity.suggestedEmail, 'alias@example.com');
  assert.equal(identity.emailVerified, false);
});

test('rejects invalid signature, algorithm, audience, issuer, dates, and nonce', async () => {
  const tampered = token().split('.');
  tampered[2] = `${tampered[2].slice(0, -2)}aa`;
  await rejectsFor(tampered.join('.'), 'signature');
  await rejectsFor(token({}, { alg: 'HS256' }), 'algorithm');
  await rejectsFor(token({ aud: '99999999-2222-3333-4444-555555555555' }), 'audience');
  await rejectsFor(token({ iss: 'https://login.microsoftonline.com/common/v2.0' }), 'issuer');
  await rejectsFor(token({ exp: NOW - 61 }), 'expired');
  await rejectsFor(token({ nbf: NOW + 61 }), 'not_active');
  await rejectsFor(token(), 'nonce', createHash('sha256').update('different').digest('hex'));
});

test('distinguishes unknown signing keys from Microsoft JWKS outages', async () => {
  const missing = new MicrosoftIdentityVerifier(CLIENT_ID, {
    async getSigningKey() {
      throw new MicrosoftSigningKeyError('not_found');
    },
  });
  await rejectsFor(token(), 'signature', NONCE_HASH, missing);
  const outage = new MicrosoftIdentityVerifier(CLIENT_ID, {
    async getSigningKey() {
      throw new MicrosoftSigningKeyError('unavailable');
    },
  });
  await assert.rejects(outage.verify(token(), NONCE_HASH), MicrosoftSigningKeyError);
});
