export type ReceiptPolicyVersion = 2 | 3;

/** API and workers share this owner so acquisition, extraction and association
 * cannot select different defaults. Policy 2 remains explicit only for legacy
 * replay/tests; activation does not backfill or delete existing account evidence.
 */
export const ACTIVE_RECEIPT_POLICY: ReceiptPolicyVersion = 3;
