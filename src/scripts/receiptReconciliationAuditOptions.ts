import {
  ACTIVE_RECEIPT_POLICY,
  type ReceiptPolicyVersion,
} from '../services/receipt/ReceiptPolicy';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const usage =
  'Usage: receipt-reconciliation-audit <user UUID> [--details] [--policy 2|3] [--staged-batches UUID,UUID], or <user UUID> --manifest UUID [--details]';

export function parseReceiptAuditOptions(args: readonly string[]) {
  const userId = args[0];
  if (!uuid.test(userId ?? '')) throw new Error(usage);
  let policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY;
  let details = false;
  let stagedBatchIds: string[] = [];
  let manifestId: string | undefined;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--details') details = true;
    else if (flag === '--policy') {
      const value = args[++i];
      if (value !== '2' && value !== '3') throw new Error(usage);
      policyVersion = value === '3' ? 3 : 2;
    } else if (flag === '--staged-batches') {
      stagedBatchIds = (args[++i] ?? '').split(',').map((id) => id.toLowerCase());
      if (
        stagedBatchIds.length > 100 ||
        stagedBatchIds.some((id) => !uuid.test(id)) ||
        new Set(stagedBatchIds).size !== stagedBatchIds.length
      )
        throw new Error(usage);
    } else if (flag === '--manifest') {
      manifestId = (args[++i] ?? '').toLowerCase();
      if (!uuid.test(manifestId)) throw new Error(usage);
    } else throw new Error(usage);
  }
  if (manifestId && (seen.has('--policy') || seen.has('--staged-batches')))
    throw new Error('Saved manifest inspection cannot override policy or staged sources');
  if (stagedBatchIds.length && policyVersion !== 3)
    throw new Error('Staged source previews require --policy 3');
  return {
    userId: userId.toLowerCase(),
    policyVersion,
    details,
    stagedBatchIds: stagedBatchIds.sort(),
    ...(manifestId ? { manifestId } : {}),
  };
}
