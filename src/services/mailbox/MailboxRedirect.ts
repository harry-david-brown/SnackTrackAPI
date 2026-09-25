import { ValidationError } from '../../core/errors';

/** Exact native destinations. Navigation metadata must not introduce nested return URLs or OAuth fields. */
export const parseMailboxRedirect = (value: string): URL => {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new ValidationError('Invalid email connection callback', 'redirectUri'); }
  const allowed = new Set(['snacktrack://oauth-callback', 'exp+snack-track://oauth-callback']);
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (!allowed.has(base) || parsed.username || parsed.password || parsed.hash ||
    [...parsed.searchParams.keys()].some((key) => !['journeyContext', 'returnTo', 'returnIntent'].includes(key))) {
    throw new ValidationError('Unsupported email connection callback', 'redirectUri');
  }
  return parsed;
};
