import { Currency, MonetaryAmount } from './types';

export interface DoorDashReceiptFields {
  orderId: string | null;
  merchant: string | null;
  currency: Currency;
  total: MonetaryAmount | null;
  subtotal: MonetaryAmount | null;
  tax: MonetaryAmount | null;
  tip: MonetaryAmount | null;
  deliveryFee: MonetaryAmount | null;
  serviceFee: MonetaryAmount | null;
  savings: number | null;
  warnings: string[];
}

interface DoorDashEmailSignals {
  from: string;
  subject: string;
  text: string;
}

interface DoorDashParseInput extends DoorDashEmailSignals {
  html: string;
  providerMessageId?: string;
  mailboxProvider?: 'gmail' | 'microsoft';
}

const MAX_AMOUNT = 1_000_000;
const MAX_MERCHANT_LENGTH = 255;
const MAX_PROVIDER_ID_LENGTH = 128;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractSenderDomain = (from: string): string | null => {
  const address = from.match(/<([^<>]+)>/)?.[1] ?? from;
  const email = address.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+)/i);
  return email?.[1]?.toLowerCase().replace(/\.$/, '') ?? null;
};

export const isTrustedDoorDashSender = (from: string): boolean => {
  const domain = extractSenderDomain(from);
  return domain === 'doordash.com' || Boolean(domain?.endsWith('.doordash.com'));
};

export const hasDoorDashReceiptContent = (subject: string, text: string): boolean => {
  const normalizedSubject = subject.trim();
  const normalizedText = text.toLowerCase();
  const hasConfirmationSubject = /^order confirmation(?:\s+for\s+.+?)?\s+from\s+.+$/i.test(
    normalizedSubject,
  );
  const hasReceiptHeading = normalizedText.includes('your receipt');
  const hasOrderAcknowledgement = normalizedText.includes('thanks for your order');
  const breakdownHits = [
    'subtotal',
    'taxes',
    'delivery fee',
    'service fee',
    'tip',
    'total charged',
  ].filter((label) => normalizedText.includes(label)).length;

  return (
    hasConfirmationSubject && (hasReceiptHeading || hasOrderAcknowledgement) && breakdownHits >= 2
  );
};

export const isDoorDashReceiptEmail = ({ from, subject, text }: DoorDashEmailSignals): boolean =>
  isTrustedDoorDashSender(from) && hasDoorDashReceiptContent(subject, text);

const parseAmount = (raw: string): MonetaryAmount | null => {
  const match = raw.match(
    /(?<leadingSign>-)?\s*(?<currency>CA\$|US\$|\$|€|£)\s*(?<trailingSign>-)?\s*(?<amount>\d{1,7}(?:\.\d{2})?)/i,
  );
  if (!match?.groups) return null;

  const amount = Number(match.groups.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) return null;

  const symbol = match.groups.currency.toUpperCase();
  const currency =
    symbol === 'CA$'
      ? Currency.CAD
      : symbol === 'US$'
        ? Currency.USD
        : symbol === '€'
          ? Currency.EUR
          : symbol === '£'
            ? Currency.GBP
            : Currency.UNKNOWN;

  return { amount: match.groups.leadingSign || match.groups.trailingSign ? -amount : amount, currency, raw: match[0] };
};

const extractLabeledAmount = (text: string, labels: readonly string[]): MonetaryAmount | null => {
  for (const label of labels) {
    const pattern = new RegExp(
      `(?:^|\\n)\\s*${escapeRegex(label)}\\s*:?\\s*(-?\\s*(?:CA\\$|US\\$|\\$|€|£)\\s*-?\\s*\\d{1,7}(?:\\.\\d{2})?)`,
      'im',
    );
    const match = text.match(pattern);
    if (match) return parseAmount(match[1]);
  }
  return null;
};

const sanitizeMerchant = (value: string | undefined): string | null => {
  if (!value) return null;
  // Control characters are intentionally stripped from provider-controlled text.
  /* eslint-disable no-control-regex -- provider text sanitization requires this range. */
  const merchant = value
    .replace(/[<>\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /* eslint-enable no-control-regex */
  if (!merchant || merchant.length > MAX_MERCHANT_LENGTH) return null;
  return merchant;
};

const extractMerchant = (subject: string, text: string): string | null => {
  const subjectMatch = subject.match(/^order confirmation(?:\s+for\s+.+?)?\s+from\s+(.+)$/i);
  const fromSubject = sanitizeMerchant(subjectMatch?.[1]);
  if (fromSubject) return fromSubject;

  const bodyMatch = text.match(/paid with[^\n]*\n\s*([^\n]{1,255})\s*\n\s*total\s*:/i);
  return sanitizeMerchant(bodyMatch?.[1]);
};

const validProviderId = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 6 || normalized.length > MAX_PROVIDER_ID_LENGTH)
    return null;
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
};

const extractOrderId = (html: string, text: string, providerMessageId?: string, mailboxProvider: 'gmail' | 'microsoft' = 'gmail'): string | null => {
  const labeled = text.match(
    /(?:doordash\s+)?order\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Za-z0-9_-]{6,128})/i,
  )?.[1];
  const fromLabel = validProviderId(labeled);
  if (fromLabel) return `doordash:${fromLabel}`;

  const urlValue = html.match(
    /[?&](?:order_id|order_uuid|delivery_uuid)=([A-Za-z0-9_-]{6,128})(?:[&#"'\s]|$)/i,
  )?.[1];
  const fromUrl = validProviderId(urlValue);
  if (fromUrl) return `doordash:${fromUrl}`;

  void providerMessageId;
  void mailboxProvider;
  return null;
};

const resolveCurrency = (text: string, amounts: readonly (MonetaryAmount | null)[]): Currency => {
  const explicit = amounts.find((amount) => amount && /^(?:CA\$|US\$)/i.test(amount.raw));
  if (explicit) return explicit.currency;

  if (
    /DoorDash Technologies Canada|\bCanada\b|,\s*(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|NT|NU|YT)\b/i.test(
      text,
    )
  ) {
    return Currency.CAD;
  }

  return (
    amounts.find((amount): amount is MonetaryAmount => amount !== null)?.currency ??
    Currency.UNKNOWN
  );
};

export const parseDoorDashReceipt = ({
  html,
  text,
  subject,
  providerMessageId,
  mailboxProvider,
}: DoorDashParseInput): DoorDashReceiptFields => {
  const warnings: string[] = [];
  const total = extractLabeledAmount(text, ['Total Charged', 'Total']);
  const subtotal = extractLabeledAmount(text, ['Subtotal']);
  const tax = extractLabeledAmount(text, ['Taxes', 'Tax']);
  const tip = extractLabeledAmount(text, ['Tip']);
  const deliveryFee = extractLabeledAmount(text, ['Delivery Fee']);
  const serviceFee = extractLabeledAmount(text, ['Service Fee']);
  const savingsAmount = extractLabeledAmount(text, [
    'Discounts',
    'Savings',
    'Promotion',
  ]);
  const merchant = extractMerchant(subject, text);
  const orderId = extractOrderId(html, text, providerMessageId, mailboxProvider);
  const amounts = [total, subtotal, tax, tip, deliveryFee, serviceFee, savingsAmount];

  if (!total) warnings.push('DoorDash receipt did not contain a valid total charged');
  if (!merchant) warnings.push('DoorDash receipt did not contain a valid merchant name');
  if (!orderId)
    warnings.push('DoorDash receipt did not expose a stable order or message identifier');

  return {
    orderId,
    merchant,
    currency: resolveCurrency(text, amounts),
    total,
    subtotal,
    tax,
    tip,
    deliveryFee,
    serviceFee,
    savings: savingsAmount ? Math.abs(savingsAmount.amount) : null,
    warnings,
  };
};
