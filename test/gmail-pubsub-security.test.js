const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeGmailPubSubNotification } = require('../dist/routes/gmailPubSub');
const { GmailPubSubVerifier } = require('../dist/services/email/GmailPubSubVerifier');

const notification = (overrides = {}) => ({
  subscription: 'projects/snacktrack-prod/subscriptions/gmail-push',
  message: {
    messageId: '1234567890',
    data: Buffer.from(JSON.stringify({
      emailAddress: 'person@example.com',
      historyId: '98765432101234567890',
    })).toString('base64url'),
    ...overrides,
  },
});

test('Gmail Pub/Sub decoder accepts only bounded mailbox wake-up metadata', () => {
  assert.deepEqual(decodeGmailPubSubNotification(notification()), {
    subscription: 'projects/snacktrack-prod/subscriptions/gmail-push',
    messageId: '1234567890',
    emailAddress: 'person@example.com',
    historyId: '98765432101234567890',
  });
  assert.equal(decodeGmailPubSubNotification(notification({ messageId: '../attack' })), null);
  assert.equal(decodeGmailPubSubNotification(notification({ data: 'x'.repeat(1_025) })), null);
  assert.equal(decodeGmailPubSubNotification({ subscription: 'unexpected', message: {} }), null);
});

test('Gmail Pub/Sub decoder rejects executable or mailbox-content-shaped data', () => {
  const data = Buffer.from(JSON.stringify({
    emailAddress: 'person@example.com',
    historyId: '1',
    subject: 'should never be accepted or stored',
  })).toString('base64url');
  assert.equal(decodeGmailPubSubNotification(notification({ data })), null);
});

test('Gmail Pub/Sub verifier requires the configured audience and service-account identity', async () => {
  const calls = [];
  const verifier = new GmailPubSubVerifier({
    audience: 'https://api.example.com/webhooks/gmail/pubsub',
    subscription: 'projects/snacktrack-prod/subscriptions/gmail-push',
    serviceAccountEmail: 'gmail-push@snacktrack-prod.iam.gserviceaccount.com',
  }, {
    verifyIdToken: async (input) => {
      calls.push(input);
      return { getPayload: () => ({ email_verified: true, email: 'gmail-push@snacktrack-prod.iam.gserviceaccount.com' }) };
    },
  });
  await verifier.verify(`Bearer ${'a'.repeat(120)}`);
  assert.equal(calls[0].audience, 'https://api.example.com/webhooks/gmail/pubsub');

  const wrongIdentity = new GmailPubSubVerifier({
    audience: 'https://api.example.com/webhooks/gmail/pubsub',
    subscription: 'projects/snacktrack-prod/subscriptions/gmail-push',
    serviceAccountEmail: 'gmail-push@snacktrack-prod.iam.gserviceaccount.com',
  }, { verifyIdToken: async () => ({ getPayload: () => ({ email_verified: true, email: 'attacker@example.com' }) }) });
  await assert.rejects(wrongIdentity.verify(`Bearer ${'b'.repeat(120)}`), (error) => error.code === 'AUTHENTICATION_REQUIRED');
});
