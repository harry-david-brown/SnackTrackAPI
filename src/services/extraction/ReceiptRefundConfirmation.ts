import type { OrderSourceEvidence } from '../../models/OrderEvidence';

// Decimal money is not a sentence boundary. Newlines still separate email sections.
const boundaries = /[!?;\n\r]|\.(?!\d)/;
function assertionContext(text: string, index: number, length: number) {
  return {
    prefix: text.slice(0, index).split(boundaries).pop() ?? '',
    suffix: text.slice(index + length).split(boundaries)[0],
  };
}

export function isCompletedActionAssertion(text: string, index: number, length: number): boolean {
  const { prefix, suffix } = assertionContext(text, index, length);
  return (
    !/["“”'>]\s*$/.test(prefix) &&
    !/\b(?:if|unless|whether|once|example|message|says|reads)\b/i.test(prefix) &&
    !/\b(?:when|after)\s*$/i.test(prefix) &&
    !/^\s*(?:request|application|claim|offer|eligibility|policy|example|guide)\b/i.test(suffix) &&
    !/\b(?:if|unless|when|once|denied|declined|rejected|failed|pending approval)\b/i.test(suffix)
  );
}

/** Scope comes from the completed assertion's order-level object, never a footer or item. */
function orderScope(assertion: string, context: string): 'full' | 'partial' | undefined {
  if (/\border['’]s\b|\b(?:except|excluding)\b/i.test(context)) return undefined;
  if (
    /\b(?:for|of|on)\s+(?:(?:your|the|a|an|all|each|any|missing|incorrect|damaged|returned)\s+){0,4}(?:items?|fees?|tips?|delivery|shipping|products?)\b/i.test(
      context,
    )
  )
    return undefined;
  const direct =
    /\b(?:fully|partially) refunded (?:your|the|this) order\b|\b(?:your|the|this) order (?:has been|was) (?:fully|partially) refunded\b|\brefunded (?:your|the|this) order in (?:full|part)\b|\b(?:your|the|this) order (?:has been|was) refunded in (?:full|part)\b|\brefunded (?:part|a portion) of (?:your|the|this) order\b/i.test(
      assertion,
    );
  const qualified = /\b(?:for|of)\s+(?:your|the|this)\s+(?:entire\s+)?order\b/i.test(context);
  if (!direct && !qualified) return undefined;
  if (/\bfull(?:y)?\b/i.test(assertion)) return 'full';
  if (/\bpartial(?:ly)?\b|\bin part\b|\b(?:part|a portion) of\b/i.test(assertion)) return 'partial';
  return undefined;
}

/** An applied refund and its size classification are independent from quantified payments. */
export function extractRefundConfirmation(text: string): {
  confirmed: boolean;
  scope?: OrderSourceEvidence['refundScope'];
} {
  const normalized = text.replace(/[’‘]/g, "'");
  const confirmations =
    /\b(?:your (?:full |partial )?refund (?:has been|was) (?:applied|issued|processed|completed)|we(?: have|'ve)? (?:issued|processed|applied|completed) (?:a |the |your )?(?:full |partial )?refund|we(?: have|'ve)? (?:fully |partially )?refunded (?:(?:your|the|this) order(?: in full| in part)?|(?:part|a portion) of (?:your|the|this) order|you\b)|you(?: have|'ve) been (?:fully |partially )?refunded|(?:your|the|this) order (?:has been|was) (?:fully refunded|partially refunded|refunded(?: in full| in part)?)|(?:a|the) (?:full|partial) refund(?: for (?:your|the|this) order)? (?:has been|was) (?:applied|issued|processed|completed))\b/gi;
  let confirmed = false;
  const scopes = new Set<'full' | 'partial'>();
  for (const match of normalized.matchAll(confirmations)) {
    if (!isCompletedActionAssertion(normalized, match.index, match[0].length)) continue;
    confirmed = true;
    const { prefix, suffix } = assertionContext(normalized, match.index, match[0].length);
    const scope = orderScope(match[0], `${prefix}${match[0]}${suffix}`);
    if (scope) scopes.add(scope);
  }
  return {
    confirmed,
    ...(scopes.size ? { scope: scopes.size > 1 ? 'conflicted' : [...scopes][0] } : {}),
  };
}
