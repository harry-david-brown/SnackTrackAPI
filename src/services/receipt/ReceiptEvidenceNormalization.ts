export const normalizeReceiptLabel = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Punctuation is insignificant; explicit branch names are not. */
export function restaurantIdentity(name = ''): { full: string; base: string; branch: boolean } {
  const cleaned = name
    .replace(/\s+and\s+Uber Eats\s*\.?$/i, '')
    .replace(/^\[Lost - Store Closed\]\s*/i, '');
  const split = cleaned.indexOf('(');
  return {
    full: normalizeReceiptLabel(cleaned),
    base: normalizeReceiptLabel(split < 0 ? cleaned : cleaned.slice(0, split)),
    branch: split >= 0,
  };
}
