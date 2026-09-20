import { decode } from 'html-entities';

/** Minimal identity only: never retain authorization URLs or unrelated tracking UUIDs. */
export function extractLinkedProviderOrderId(
  html: string,
  provider: 'uber_eats' | 'doordash',
): string | undefined {
  const ids = new Set<string>();
  // Read actual anchor attributes, not data-href, title text or serialized URLs.
  const links = [...html.matchAll(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)].flatMap((anchor) =>
    [...anchor[0].matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
      .filter((attribute) => attribute[1].toLowerCase() === 'href')
      .map((attribute) => attribute[2] ?? attribute[3] ?? attribute[4] ?? ''),
  );
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(decode(link));
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    const domain =
      provider === 'uber_eats'
        ? /(?:^|\.)(?:uber\.com|ubereats\.com)$/i
        : /(?:^|\.)doordash\.com$/i;
    if (!domain.test(url.hostname)) continue;
    const candidates = [
      ...url.searchParams.getAll('order_uuid'),
      ...url.searchParams.getAll('eats_order_uuid'),
      ...(provider === 'doordash' ? url.searchParams.getAll('order_id') : []),
      url.pathname.match(/\/(?:orders?|receipt)\/([a-f\d-]{36})(?:\/|$)/i)?.[1],
    ];
    for (const candidate of candidates)
      if (candidate && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(candidate))
        ids.add(candidate.toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}
