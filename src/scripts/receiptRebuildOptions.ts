import { randomUUID } from 'crypto';

export function receiptRebuildOptions(args: readonly string[]) {
  const positional: string[] = [];
  let reviewFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reviews') {
      if (reviewFile !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error('Provide --reviews once with a local JSON file');
      reviewFile = args[++i];
    } else if (args[i].startsWith('--')) throw new Error('Unsupported receipt rebuild option');
    else positional.push(args[i]);
  }
  const [mode, userId, idempotencyKey = randomUUID(), manifestOrBatches] = positional;
  const uuid = (value: string | undefined) =>
    typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  if (
    positional.length < 2 ||
    positional.length > 4 ||
    !uuid(userId) ||
    (mode !== 'prepare' && mode !== 'publish' && mode !== 'rollback')
  )
    throw new Error(
      'Usage: receipt-rebuild <prepare|publish|rollback> <account UUID> [idempotency key] [staged batch UUIDs or publish/rollback manifest UUID] [--reviews FILE]',
    );
  if (!idempotencyKey.trim() || idempotencyKey.length > 200)
    throw new Error('Invalid repair idempotency key');
  if (mode !== 'prepare') {
    if (!uuid(manifestOrBatches) || reviewFile !== undefined)
      throw new Error(
        'Publish/rollback require a saved manifest UUID and cannot accept new reviews',
      );
    return { mode, userId, idempotencyKey, manifestId: manifestOrBatches, stagedBatchIds: [] };
  }
  const stagedBatchIds = manifestOrBatches?.split(',').map((id) => id.toLowerCase()) ?? [];
  if (
    stagedBatchIds.length > 100 ||
    stagedBatchIds.some((id) => !uuid(id)) ||
    new Set(stagedBatchIds).size !== stagedBatchIds.length
  )
    throw new Error('Invalid or duplicate staged repair batch UUIDs');
  return { mode, userId, idempotencyKey, stagedBatchIds, reviewFile };
}
