import type { OrderObservation } from './OrderFinancialResolver';
import { sourceOrderEvidence } from './OrderFinancialResolver';
import { providerId } from './ReceiptObservationMatching';
import { paymentTimestampKey } from './OrderPaymentEvents';
import {
  currentSourceInterpretations,
  sourceDocumentIdentity,
  conflictingSourceDocuments,
} from './ReceiptSourceInterpretations';
import {
  normalizeReceiptLabel as normalize,
  restaurantIdentity,
} from './ReceiptEvidenceNormalization';

const minor = (value: number) => Math.round(value * 100);

function compatible(a: OrderObservation, b: OrderObservation): boolean {
  const ar = a.receipt,
    br = b.receipt;
  if (
    ar.dataSource !== 'email' ||
    br.dataSource !== 'email' ||
    ar.userId !== br.userId ||
    ar.receiptType !== br.receiptType
  )
    return false;
  if (providerId(ar) && providerId(br) && providerId(ar) !== providerId(br)) return false;
  const ac = ar.monetaryDetails?.currencyCode,
    bc = br.monetaryDetails?.currencyCode;
  return !ac || !bc || ac === 'UNKNOWN' || bc === 'UNKNOWN' || ac === bc;
}

/** Receipt-family evidence needs more than the same amount; independent originals never join. */
function updates(
  edit: OrderObservation,
  earlier: OrderObservation,
  aliases: readonly OrderObservation[],
): boolean {
  if (!compatible(edit, earlier)) return false;
  const e = sourceOrderEvidence(edit.receipt),
    p = sourceOrderEvidence(earlier.receipt);
  if (!['updated', 'refund'].includes(e.documentKind)) return false;
  if (e.revisionOf)
    return aliases.some(
      (alias) =>
        sourceDocumentIdentity(alias) === sourceDocumentIdentity(earlier) &&
        (e.revisionOf === alias.id || e.revisionOf === alias.receipt.resolution?.sourceMessageId),
    );
  const merchant = restaurantIdentity(edit.receipt.restaurantName).full;
  if (
    !merchant ||
    merchant === 'unknown restaurant' ||
    merchant !== restaurantIdentity(earlier.receipt.restaurantName).full
  )
    return false;
  if (!e.orderHeaderDay || e.orderHeaderDay !== p.orderHeaderDay) return false;
  if (
    e.previousTotal === undefined ||
    p.recordedTotal === null ||
    minor(e.previousTotal) !== minor(p.recordedTotal)
  )
    return false;
  const courier = e.courier && p.courier && normalize(e.courier) === normalize(p.courier);
  const payment = e.payments.some(
    (a) =>
      a.kind === 'charge' &&
      a.timestamp &&
      p.payments.some(
        (b) =>
          b.kind === 'charge' &&
          b.timestamp?.role === 'payment' &&
          a.timestamp?.role === 'payment' &&
          a.timestamp.precision !== 'day' &&
          b.timestamp.precision !== 'day' &&
          paymentTimestampKey(a) === paymentTimestampKey(b) &&
          minor(a.amount) === minor(b.amount) &&
          a.tender === b.tender &&
          a.cardLastFour === b.cardLastFour,
      ),
  );
  const basket = (o: OrderObservation) =>
    o.receipt.items
      .map((i) => `${normalize(i.evidence?.rawName ?? i.name)}:${i.quantity}`)
      .sort()
      .join('|');
  return Boolean(
    courier ||
    payment ||
    (edit.receipt.items.length && earlier.receipt.items.length && basket(edit) === basket(earlier)),
  );
}

/** Initial groups already collapse copies and scoped provider identities. */
export function groupReceiptFamilies(
  initial: readonly (readonly OrderObservation[])[],
  canAssociate: (a: readonly OrderObservation[], b: readonly OrderObservation[]) => boolean = () =>
    true,
): OrderObservation[][] {
  const current = initial.map((group) => currentSourceInterpretations(group));
  const conflicts = conflictingSourceDocuments(initial.flatMap((group) => [...group]));
  const disputed = current.map((group) =>
    group.some((o) => conflicts.has(sourceDocumentIdentity(o))),
  );
  const parent = initial.map((_, i) => i);
  const root = (index: number): number => (parent[index] === index ? index : root(parent[index]));
  const edges: [number, number][] = [];
  for (let e = 0; e < initial.length; e++) {
    const candidates = current
      .map((group, i) =>
        i !== e &&
        !disputed[e] &&
        !disputed[i] &&
        canAssociate(initial[e], initial[i]) &&
        current[e].some((edit) => group.some((earlier) => updates(edit, earlier, initial[i])))
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    if (candidates.length === 1) edges.push([e, candidates[0]]);
  }
  // Two incompatible updates of the same original are retained in the family,
  // but financial resolution explicitly flags the competing revision branches.
  for (const [a, b] of edges) {
    const membersA = current.flatMap((group, i) => (root(i) === root(a) ? [...group] : []));
    const membersB = current.flatMap((group, i) => (root(i) === root(b) ? [...group] : []));
    if (
      canAssociate(membersA, membersB) &&
      membersA.every((left) => membersB.every((right) => compatible(left, right)))
    )
      parent[root(a)] = root(b);
  }
  const output = new Map<number, OrderObservation[]>();
  initial.forEach((group, i) => output.set(root(i), [...(output.get(root(i)) ?? []), ...group]));
  return [...output.values()].map((group) => group.sort((a, b) => a.id.localeCompare(b.id)));
}
