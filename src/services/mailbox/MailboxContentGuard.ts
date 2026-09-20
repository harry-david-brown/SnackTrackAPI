import { domainToASCII } from 'url';
import { extractLinkedProviderOrderId } from '../receipt/ReceiptProviderOrderIdentity';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';

export type MailboxAuthenticationOutcome = 'pass' | 'fail' | 'none' | 'unavailable';
export type MailboxRejectionReason =
  | 'message_too_large'
  | 'body_too_large'
  | 'sender_not_allowed'
  | 'dmarc_failed'
  | 'provider_payload_invalid';

export interface MailboxGuardResult {
  readonly accepted: boolean;
  readonly reason?: MailboxRejectionReason;
  readonly body: string;
  readonly decodedBytes: number;
  readonly authentication: MailboxAuthenticationOutcome;
}

const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ADDRESS_BYTES = 16 * 1024;
const MAX_SUBJECT_BYTES = 32 * 1024;
const MAX_AUTHENTICATION_HEADER_BYTES = 32 * 1024;
const MAX_AUTHENTICATION_HEADERS_BYTES = 128 * 1024;
const TRUSTED_DOMAINS = ['uber.com', 'ubereats.com', 'doordash.com'] as const;

const senderDomain = (from: string): string | null => {
  const address = from.match(/<([^<>]+)>/)?.[1] ?? from;
  const match = address.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+)/i);
  if (!match) return null;
  const domain = domainToASCII(match[1].toLowerCase().replace(/\.$/, ''));
  return domain || null;
};

const trustedDomain = (domain: string | null): boolean => Boolean(domain && TRUSTED_DOMAINS.some(
  (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
));

export const trustedAuthenticationResult = (
  provider: 'gmail' | 'microsoft',
  headers: readonly string[],
): string | null => {
  const expected = provider === 'gmail' ? /^(?:mx\.)?google\.com\s*;/i : /^(?:[^;]*\.)?protection\.outlook\.com\s*;/i;
  return headers.find((value) => expected.test(value.trim())) ?? null;
};

const dmarcOutcome = (value: string | null, visibleDomain: string | null): MailboxAuthenticationOutcome => {
  if (!value) return 'unavailable';
  const match = value.match(/(?:^|[;\s])dmarc=(pass|fail|none|neutral|temperror|permerror)\b/i);
  if (!match) return 'unavailable';
  const result = match[1].toLowerCase();
  const aligned = value.match(/header\.from=([^;\s]+)/i)?.[1]?.toLowerCase().replace(/\.$/, '');
  if (aligned && visibleDomain && aligned !== visibleDomain && !visibleDomain.endsWith(`.${aligned}`)) return 'unavailable';
  return result === 'pass' ? 'pass' : result === 'fail' ? 'fail' : 'none';
};

const sanitizeHtml = (body: string, retainOrderReferences: boolean): string => {
  const content = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|iframe|object|embed|form|video|audio|picture|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(img|source|track|input|link|meta)\b[^>]*>/gi, ' ');
  const references = retainOrderReferences
    ? (['uber_eats', 'doordash'] as const).flatMap((provider) => {
        const id = extractLinkedProviderOrderId(content, provider);
        const host = provider === 'uber_eats' ? 'www.ubereats.com' : 'www.doordash.com';
        // This is a reconstructed identity marker for extraction, not the original
        // clickable receipt URL. No query string, access token or tracking is retained.
        return id ? [`<a href="https://${host}/orders/${id}">Order reference</a>`] : [];
      }).join('')
    : '';
  return content.replace(/\b(?:src|href|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' ') + references;
};

export class MailboxContentGuard {
  constructor(private readonly receiptPolicy: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY) {}

  preflight(input: {
    provider: 'gmail' | 'microsoft';
    from: string;
    to?: string;
    subject?: string;
    providerBytes?: number;
    authenticationHeaders?: readonly string[];
    allowForwardedReceipts: boolean;
  }): Omit<MailboxGuardResult, 'body' | 'decodedBytes'> {
    if (input.providerBytes !== undefined && input.providerBytes > MAX_PROVIDER_BYTES) {
      return { accepted: false, reason: 'message_too_large', authentication: 'unavailable' };
    }
    const authenticationBytes = (input.authenticationHeaders ?? []).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    if (
      Buffer.byteLength(input.from) > MAX_ADDRESS_BYTES ||
      Buffer.byteLength(input.to ?? '') > MAX_ADDRESS_BYTES ||
      Buffer.byteLength(input.subject ?? '') > MAX_SUBJECT_BYTES ||
      authenticationBytes > MAX_AUTHENTICATION_HEADERS_BYTES ||
      (input.authenticationHeaders ?? []).some((value) => Buffer.byteLength(value) > MAX_AUTHENTICATION_HEADER_BYTES)
    ) {
      return { accepted: false, reason: 'provider_payload_invalid', authentication: 'unavailable' };
    }
    const domain = senderDomain(input.from);
    const authentication = dmarcOutcome(
      trustedAuthenticationResult(input.provider, input.authenticationHeaders ?? []),
      domain,
    );
    if (!input.allowForwardedReceipts && !trustedDomain(domain)) {
      return { accepted: false, reason: 'sender_not_allowed', authentication };
    }
    if (!input.allowForwardedReceipts && authentication === 'fail') {
      return { accepted: false, reason: 'dmarc_failed', authentication };
    }
    return { accepted: true, authentication };
  }

  acceptBody(body: string, preflight: Omit<MailboxGuardResult, 'body' | 'decodedBytes'>): MailboxGuardResult {
    if (!preflight.accepted) return { ...preflight, body: '', decodedBytes: 0 };
    const decodedBytes = Buffer.byteLength(body, 'utf8');
    if (decodedBytes > MAX_BODY_BYTES) return { accepted: false, reason: 'body_too_large', body: '', decodedBytes, authentication: preflight.authentication };
    const sanitized = sanitizeHtml(body, this.receiptPolicy === 3);
    return { accepted: true, body: sanitized, decodedBytes, authentication: preflight.authentication };
  }
}
