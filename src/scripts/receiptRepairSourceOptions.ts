import type { ReceiptRepairSourceCommand } from '../services/receipt/ReceiptRepairSourceAcquisition';

const usage =
  'Usage: receipt-repair-export <user UUID> <uber_eats|doordash> <retained CSV/ZIP path>, or receipt-repair-email <user UUID> <gmail|microsoft> <uber_eats|doordash> <retained JSON path>; optional --acquired-at UTC-ISO-timestamp and --stage --expected-generation N --expected-fingerprint SHA256';

export function parseReceiptRepairSourceOptions(
  args: readonly string[],
  sourceKind: 'provider_export' | 'retained_email',
  now = new Date(),
): ReceiptRepairSourceCommand {
  const userId = args[0];
  const providerIndex = sourceKind === 'retained_email' ? 2 : 1;
  const provider = args[providerIndex], path = args[providerIndex + 1];
  const mailboxProvider = args[1];
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId ?? '') ||
    (provider !== 'uber_eats' && provider !== 'doordash') ||
    !path ||
    path.startsWith('--')
  )
    throw new Error(usage);
  if (sourceKind === 'retained_email' && mailboxProvider !== 'gmail' && mailboxProvider !== 'microsoft') throw new Error(usage);
  let acquiredAt = now.toISOString();
  let stage = false;
  let expectedGeneration: number | undefined;
  let expectedFingerprint: string | undefined;
  const seen = new Set<string>();
  for (let i = providerIndex + 2; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--stage') stage = true;
    else if (flag === '--acquired-at') acquiredAt = args[++i] ?? '';
    else if (flag === '--expected-generation') {
      const value = args[++i] ?? '';
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(usage);
      expectedGeneration = Number(value);
    } else if (flag === '--expected-fingerprint') {
      expectedFingerprint = (args[++i] ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error(usage);
    } else throw new Error(usage);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(acquiredAt) ||
    !Number.isFinite(Date.parse(acquiredAt)) ||
    new Date(acquiredAt).toISOString() !== acquiredAt
  )
    throw new Error(usage);
  if (!stage && (expectedGeneration !== undefined || expectedFingerprint !== undefined))
    throw new Error(usage);
  const command: ReceiptRepairSourceCommand = sourceKind === 'retained_email' && (mailboxProvider === 'gmail' || mailboxProvider === 'microsoft')
    ? {sourceKind,mailboxProvider,userId:userId.toLowerCase(),provider,path,acquiredAt}
    : {sourceKind:'provider_export',userId:userId.toLowerCase(),provider,path,acquiredAt};
  if (stage) {
    if (expectedGeneration === undefined || !expectedFingerprint || !seen.has('--acquired-at'))
      throw new Error(
        'Staging requires acquiredAt, generation and fingerprint from the reviewed preview',
      );
    return {
      ...command,
      stage: { expectedGeneration, expectedFingerprint },
    };
  }
  return command;
}
