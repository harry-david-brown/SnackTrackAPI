import type {
  OrderSourceEvidence,
  OrderTimestamp,
  PaymentEvidence,
  Tender,
} from '../../models/OrderEvidence';
import { decode } from 'html-entities';
import { parseReceiptLocalDateTime } from '../../utils/timezone';
import { extractRefundConfirmation, isCompletedActionAssertion } from './ReceiptRefundConfirmation';

const MONEY = '(?:-\\s*)?(?:CA\\$|US\\$|CAD\\s*|USD\\s*|\\$|€|£)\\s*-?\\s*(\\d[\\d,]*\\.\\d{2})';
const DATE =
  '(?:\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4})';
const TIME = '\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)';
const cents = (value: string) => Number(value.replace(/,/g, ''));
const moneyCurrency = (value: string): PaymentEvidence['currencyCode'] =>
  /CA\$|CAD/i.test(value)
    ? 'CAD'
    : /US\$|USD/i.test(value)
      ? 'USD'
      : value.includes('€')
        ? 'EUR'
        : value.includes('£')
          ? 'GBP'
          : 'UNKNOWN';
const paymentReference = (text: string, refundOnly = false): string | undefined =>
  text.match(
    new RegExp(
      `\\b${refundOnly ? 'refund' : '(?:transaction|payment|refund)'}\\s+(?:id|reference)\\s*[:#]\\s*([a-z\\d][a-z\\d_-]{1,127})(?=\\s|$|[.,;])`,
      'i',
    ),
  )?.[1];
const labeledAmount = (text: string, label: string): number | undefined => {
  const match = text.match(new RegExp(`\\b${label}\\s*:?\\s*${MONEY}`, 'i'));
  return match ? cents(match[1]) : undefined;
};

const dayFromText = (raw: string): string | undefined => {
  const numeric = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  let year: number, month: number, day: number;
  if (numeric) {
    year = Number(numeric[3]);
    if (year < 100) year += 2000;
    month = Number(numeric[1]);
    day = Number(numeric[2]);
  } else {
    const words = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (!words) return undefined;
    month =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        words[1].slice(0, 3).toLowerCase(),
      ) + 1;
    day = Number(words[2]);
    year = Number(words[3]);
  }
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return month &&
    Number.isFinite(Date.parse(iso)) &&
    new Date(iso).toISOString().slice(0, 10) === iso
    ? iso
    : undefined;
};

function timestamp(raw: string, role: OrderTimestamp['role'], timezone?: string): OrderTimestamp {
  const date = raw.match(new RegExp(DATE, 'i'))?.[0];
  const time = raw.match(new RegExp(TIME, 'i'))?.[0];
  const day = date ? dayFromText(date) : undefined;
  const numericDay = day ? `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}` : undefined;
  const instant =
    timezone && numericDay && time
      ? parseReceiptLocalDateTime(numericDay, time, timezone)?.toISOString()
      : undefined;
  return { role, raw, precision: time ? 'minute' : 'day', ...(instant ? { instant } : {}) };
}

function paymentsFromText(text: string, timezone?: string): PaymentEvidence[] {
  const start = text.search(/\bPayments?\b/i);
  if (start < 0) return [];
  const section = text
    .slice(start)
    .split(
      /Switch Payment Method|You ordered from|Delivered to|Download PDF|Visit (?:the|this) order page/i,
    )[0];
  const tenders = [
    ...section.matchAll(
      /(?:Visa|Mastercard|Amex|American Express|Discover)\s*[•·…*]+\s*(\d{4})|Uber\s+Cash|DoorDash\s+credits?/gi,
    ),
  ];
  return tenders.flatMap((match, index): PaymentEvidence[] => {
    const chunk = section.slice(match.index, tenders[index + 1]?.index ?? section.length);
    const money = chunk.match(new RegExp(MONEY, 'i'));
    if (!money) return [];
    const rawTime = chunk.match(new RegExp(`${DATE}\\s+${TIME}`, 'i'))?.[0];
    const kind = /refund\s+revers(?:al|ed)|refund\s+cancell?ed/i.test(chunk)
      ? 'refund_reversal'
      : /refund/i.test(chunk) || /^\s*-/.test(money[0]) || /\$\s*-/.test(money[0])
        ? 'refund'
        : 'charge';
    const tender: Tender = match[1] ? 'card' : 'provider_wallet';
    const currencyCode = moneyCurrency(money[0]);
    const reference = paymentReference(chunk);
    return [
      {
        kind,
        amount: cents(money[1]),
        tender,
        currencyCode,
        ...(reference ? { reference } : {}),
        ...(match[1] ? { cardLastFour: match[1] } : {}),
        // Updated receipts repeat the original payment time on the refund row.
        // That timestamp is evidence of the payment, not a claimed refund-event time.
        ...(rawTime ? { timestamp: timestamp(rawTime, 'payment', timezone) } : {}),
      },
    ];
  });
}

export interface EmailOrderEvidenceInput {
  text: string;
  total: number | null;
  receivedAt?: Date;
  timezone?: string;
}

/** No payment timestamp is ever promoted to order placement time. */
export function extractEmailOrderEvidence(input: EmailOrderEvidenceInput): OrderSourceEvidence {
  const text = decode(input.text).replace(/\u00a0/g, ' ').replace(/[’‘]/g, "'");
  const cancellation = /your order (?:has been|was) cancell?ed|cancellation fee/i.test(text);
  const updated =
    /(?:we|uber|doordash) (?:have )?updated your receipt|updated receipt|revised (?:receipt|total)|\bprevious total\b/i.test(
      text,
    );
  const previousTotal = labeledAmount(text, 'previous total');
  const newTotal = labeledAmount(text, '(?:new|revised) total');
  const payments = paymentsFromText(text, input.timezone);
  // An amount refunded is a financial event, not the new balance of the order.
  // Require affirmative completed-action wording; refund policies/offers are not evidence.
  const refundNotice = [
    ...text.matchAll(
      new RegExp(
        `\\b(?:we(?: have|'ve)? refunded(?: you)?|you(?: have|'ve) been refunded|we(?: have|'ve)? (?:issued|processed|applied|completed) (?:a |the |your )?(?:full |partial )?refund(?: (?:of|in the amount of))?|your (?:full |partial )?refund (?:has been|was) (?:applied|issued|processed|completed))\\s*:?\\s+${MONEY}`,
        'gi',
      ),
    ),
  ].find((match) => isCompletedActionAssertion(text, match.index, match[0].length));
  const explicitRefund =
    (refundNotice ? cents(refundNotice[1]) : undefined) ??
    (() => {
      const match = text.match(
        new RegExp(`(?:^|[\\n\\r])\\s*Refund(?: amount)?\\s*:?\\s*${MONEY}`, 'i'),
      );
      return match ? cents(match[1]) : undefined;
    })() ??
    (() => {
      const m = text.match(new RegExp(`${MONEY}\\s*Refund(?:[ \\t]*[\\n\\r]|$)`, 'i'));
      return m ? cents(m[1]) : undefined;
    })();
  const refundPayments = payments.filter((p) => p.kind === 'refund');
  const refundConfirmation = extractRefundConfirmation(text);
  const appliedRefund = refundConfirmation.confirmed;
  const refund = appliedRefund || explicitRefund !== undefined || refundPayments.length > 0;
  const destinations = [...new Set(refundPayments.map((p) => p.tender))];
  const noticeDestination: Tender | undefined =
    (refundNotice || appliedRefund) &&
    /\b(?:to|in)\s+(?:your\s+)?(?:Uber\s+Cash|DoorDash\s+credits?)\b/i.test(text)
      ? 'provider_wallet'
      : undefined;
  // Only the header date is a safe order day; later dates belong to payments/events.
  const header = text.split(
    /Payments?|Previous Total|New Total|You ordered from|Delivered to|Here's your receipt|Thanks for/i,
  )[0];
  const rawDay = header.match(new RegExp(DATE, 'i'))?.[0];
  // A refund notice's header normally dates the refund. Only explicit order text
  // may establish its purchase day when it does not contain a receipt balance.
  const balanceText = text.replace(
    new RegExp(`\\b(?:previous|refund)\\s+total\\s*:?\\s*${MONEY}`, 'gi'),
    '',
  );
  const refundBalance = labeledAmount(balanceText, '(?:(?:new|revised|order)\\s+)?total');
  const recordedTotal = newTotal ?? (refund ? (refundBalance ?? null) : input.total);
  const explicitOrderDay = text.match(
    new RegExp(`\\b(?:Order date|Order placed|Placed on|Ordered on)\\s*:?\\s*(${DATE})`, 'i'),
  )?.[1];
  const orderHeaderDay = explicitOrderDay
    ? dayFromText(explicitOrderDay)
    : rawDay && (!refund || recordedTotal !== null)
      ? dayFromText(rawDay)
      : undefined;
  const timestamps: OrderTimestamp[] = [];
  for (const [label, role] of [
    ['(?:Order placed|Placed on|Ordered at)', 'placed'],
    ['(?:Delivered at|Delivered on)', 'delivered'],
    ['(?:Refunded on|Refund issued on)', 'refund'],
  ] as const) {
    const raw = text.match(
      new RegExp(`${label}\\s*:?\\s*(${DATE}(?:\\s+(?:at\\s+)?${TIME})?|${TIME})`, 'i'),
    )?.[1];
    if (raw)
      timestamps.push(
        timestamp(
          raw.match(new RegExp(DATE, 'i')) || !(role === 'refund' ? rawDay : orderHeaderDay)
            ? raw
            : `${role === 'refund' ? rawDay : (explicitOrderDay ?? rawDay)} ${raw}`,
          role,
          input.timezone,
        ),
      );
  }
  if (input.receivedAt && Number.isFinite(input.receivedAt.getTime()))
    timestamps.push({
      role: 'received',
      raw: input.receivedAt.toISOString(),
      instant: input.receivedAt.toISOString(),
      precision: 'second',
    });
  timestamps.push(...payments.flatMap((p) => (p.timestamp ? [p.timestamp] : [])));
  if (explicitRefund !== undefined && refundPayments.length === 0) {
    const reference = paymentReference(text, true);
    const refundedAt = timestamps.find((value) => value.role === 'refund');
    payments.push({
      kind: 'refund',
      amount: explicitRefund,
      tender: noticeDestination ?? 'unknown',
      ...(refundNotice ? { currencyCode: moneyCurrency(refundNotice[0]) } : {}),
      ...(reference ? { reference } : {}),
      ...(refundedAt ? { timestamp: refundedAt } : {}),
    });
  }
  const courier = text
    .match(/Delivered by\s+([^\n\r]+?)(?=\s+(?:Contact support|My orders)|$|[\n\r])/i)?.[1]
    ?.trim();
  const cancellationReason = text
    .match(/[^\n.]*had already started your order[^.]*\./i)?.[0]
    ?.trim();
  return {
    version: 1,
    parserVersion: 3,
    documentKind: cancellation
      ? 'cancellation'
      : updated
        ? 'updated'
        : refund
          ? 'refund'
          : 'original',
    fulfillment: cancellation
      ? 'canceled'
      : courier || /your order (?:was|has been) delivered/i.test(text)
        ? 'completed'
        : 'unknown',
    ...(orderHeaderDay ? { orderHeaderDay } : {}),
    timestamps,
    recordedTotal,
    totalState: recordedTotal === null ? 'unavailable' : 'known',
    ...(previousTotal === undefined ? {} : { previousTotal }),
    ...(explicitRefund === undefined ? {} : { refundAmount: explicitRefund }),
    ...(refundConfirmation.scope ? { refundScope: refundConfirmation.scope } : {}),
    ...(appliedRefund && explicitRefund === undefined && refundPayments.length === 0
      ? {
          refundConfirmed: true as const,
          ...(paymentReference(text, true)
            ? { refundReference: paymentReference(text, true) }
            : {}),
        }
      : {}),
    ...(destinations.length === 1
      ? { refundDestination: destinations[0] }
      : noticeDestination
        ? { refundDestination: noticeDestination }
        : {}),
    ...(courier ? { courier } : {}),
    ...(cancellationReason ? { cancellationReason } : {}),
    ...(recordedTotal === 0 &&
    /(?:entire order|order total|full amount).{0,40}(?:covered by|paid (?:for )?with) (?:a )?(?:promo|coupon)|(?:promo|coupon).{0,40}covered (?:your |the )?(?:entire|full) order/i.test(
      text,
    )
      ? { promotionExplainsZero: true }
      : {}),
    payments,
    issues:
      refundConfirmation.scope === 'conflicted'
        ? ['Conflicting explicit order-level refund descriptions']
        : [],
  };
}
