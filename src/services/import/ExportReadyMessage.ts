import type { ExportProvider } from './ImportLifecycleTypes';

/** Exact sender domains and ready language; never follow links in the message. */
export function isExportReadyMessage(provider: ExportProvider, from: string, subject: string, body: string): boolean {
  const address = from.match(/<([^<>]+)>/)?.[1] ?? from.trim();
  const domain = address.split('@')[1]?.toLowerCase();
  const trusted = provider === 'doordash' ? ['doordash.com'] : ['uber.com', 'ubereats.com'];
  if (!domain || !trusted.some(d => domain === d || domain.endsWith(`.${d}`))) return false;
  const text = `${subject}\n${body}`.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (provider === 'doordash') return /(?:data|archive).{0,60}(?:is |now )?ready|ready.{0,60}(?:data|archive)/.test(text)
    && /view your data archive|download (?:your |the )?(?:data|archive)/.test(text);
  return text.includes('your uber data is ready for download')
    || ((text.includes('your uber data is now ready') || text.includes('ready for you to download')) && text.includes('go to download page'))
    || (text.includes('download your data') && text.includes('available for 7 days') && text.includes('sign in at the link below'));
}
