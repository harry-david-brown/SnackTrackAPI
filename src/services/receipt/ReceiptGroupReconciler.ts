import { DataSource, Receipt, ReceiptWriteCommand } from '../../models/Receipt';
import { getLocalDateKey, zonedDateTimeToUtc } from '../../utils/timezone';
import { providerId } from './ReceiptObservationMatching';
import { resolveObservations } from './ReceiptResolutionService';
import { groupReceiptFamilies } from './ReceiptFamilyResolver';
import { resolveOrderOutcome, sourceOrderEvidence } from './OrderFinancialResolver';
import { ACTIVE_RECEIPT_POLICY } from './ReceiptPolicy';
import type { ReceiptReview } from './ReceiptReviewDecisions';
import { reviewedAssociations } from './ReceiptReviewedAssociations';
import {
  currentSourceInterpretations,
  sourceDocumentIdentity,
  conflictingSourceDocuments,
} from './ReceiptSourceInterpretations';
import { doorDashDeliveryIdentity } from './DoorDashExportEvidence';
import {
  normalizeReceiptLabel as normalize,
  restaurantIdentity,
} from './ReceiptEvidenceNormalization';
export { restaurantIdentity } from './ReceiptEvidenceNormalization';

export const RECONCILIATION_POLICY = ACTIVE_RECEIPT_POLICY;
export interface SourceObservation {
  id: string;
  receiptId?: string;
  /** Rolled-back acquisitions remain inspectable but require explicit reactivation. */
  associationEnabled?: false;
  /** Trace a detached source back to its last projection without keeping it counted. */
  lastReceiptId?: string;
  receipt: ReceiptWriteCommand;
}
export interface ExportCoverage {
  batchId?: string;
  provider: string;
  start: string;
  end: string;
  quality: 'observed' | 'declared';
  incomplete: boolean;
}
export interface ReconciledGroup {
  policyVersion?: 2 | 3;
  reviewIds?: string[];
  invalidReviewIds?: string[];
  observations: SourceObservation[];
  method:
    | 'reviewed'
    | 'identity'
    | 'receipt_family'
    | 'lifecycle_amount'
    | 'final_amount'
    | 'unique_day'
    | 'basket'
    | 'subtotal'
    | 'time'
    | 'standalone';
  reason?:
    | 'review_conflict'
    | 'ambiguous'
    | 'no_export_candidate'
    | 'identity_conflict'
    | 'currency_conflict'
    | 'incomplete_export'
    | 'unlinked_adjustment'
    | 'lifecycle_conflict';
}
const validMerchant = (name: string) =>
  Boolean(name) && !['unknown', 'unknown restaurant'].includes(name);
const representative = (g: SourceObservation[]) => resolveObservations(g.map((o) => o.receipt));
const identityCompatible = (a: ReceiptWriteCommand, b: ReceiptWriteCommand) =>
  !(providerId(a) && providerId(b) && providerId(a) !== providerId(b));
const currencyCompatible = (a: ReceiptWriteCommand, b: ReceiptWriteCommand) => {
  const ac = a.monetaryDetails?.currencyCode,
    bc = b.monetaryDetails?.currencyCode;
  return !ac || !bc || ac === 'UNKNOWN' || bc === 'UNKNOWN' || ac === bc;
};
const sourceKey = (r: ReceiptWriteCommand, id: string, policyVersion: 2 | 3, timezone: string) => {
  const scope = `${r.userId}:${r.receiptType}:${r.dataSource}:`;
  if (providerId(r)) return `${scope}provider:${providerId(r)}`;
  if (r.resolution?.sourceMessageId) return `${scope}message:${r.resolution.sourceMessageId}`;
  if (r.dataSource === DataSource.CSV && r.orderDate) {
    const delivery =
      policyVersion === 3 && r.receiptType === 'doordash'
        ? doorDashDeliveryIdentity(
            r.resolution?.timestamp?.deliveryRaw ?? r.deliveryTime?.toISOString() ?? '',
            r.resolution?.timestamp?.timezone ?? timezone,
          )
        : '';
    return `${scope}export:${restaurantIdentity(r.restaurantName).full}:${r.orderDate.toISOString()}:${delivery}`;
  }
  return `${scope}observation:${id}`;
};
const day = (r: ReceiptWriteCommand, timezone: string) => {
  if (r.resolution?.orderEvidence?.orderHeaderDay) return r.resolution.orderEvidence.orderHeaderDay;
  if (!r.orderDate || !Number.isFinite(r.orderDate.getTime())) return null;
  // Date-only receipt text is a calendar value, not a midnight instant to shift.
  if (r.resolution?.timestamp?.precision === 'day') return r.resolution.timestamp.raw.slice(0, 10);
  return getLocalDateKey(r.orderDate, timezone);
};
const timeDistance = (e: ReceiptWriteCommand, x: ReceiptWriteCommand) => {
  if (!e.orderDate || !x.orderDate || e.resolution?.timestamp?.precision !== 'minute')
    return Infinity;
  const start = x.orderDate.getTime(),
    finish = x.deliveryTime?.getTime();
  const end =
    finish !== undefined && finish >= start && finish - start <= 6 * 3600000 ? finish : start;
  return Math.max(start - e.orderDate.getTime(), e.orderDate.getTime() - end, 0);
};
const basket = (r: ReceiptWriteCommand) =>
  r.items
    .map((i) => `${normalize(i.evidence?.rawName ?? i.name)}:${i.quantity}`)
    .sort()
    .join('|');

/** A revised receipt can describe the purchase even when its original email is absent. */
const hasOrderSnapshot = (receipt: ReceiptWriteCommand): boolean => {
  if (receipt.resolution?.orderOutcome?.kind !== 'unlinked_adjustment') return true;
  const evidence = sourceOrderEvidence(receipt);
  return (
    ['updated', 'refund'].includes(evidence.documentKind) &&
    Boolean(evidence.orderHeaderDay) &&
    evidence.previousTotal !== undefined &&
    evidence.recordedTotal !== null
  );
};

/** Wide interval windows apply to semantic evidence, never presumed equal times. */
function withinOrderWindow(email: ReceiptWriteCommand, exported: ReceiptWriteCommand): boolean {
  if (!exported.orderDate) return false;
  let start = exported.orderDate.getTime();
  const ending = sourceOrderEvidence(exported).timestamps.find(
    (t) => t.role === 'ended' || t.role === 'delivered',
  )?.instant;
  const finish = ending ? Date.parse(ending) : (exported.deliveryTime?.getTime() ?? start);
  let end =
    Number.isFinite(finish) && finish >= start && finish - start <= 24 * 3600000 ? finish : start;
  if (exported.resolution?.timestamp?.precision === 'day') {
    // Coarse or ambiguous export timing spans its whole event-local day, not an invented
    // midnight placement. Stronger amount/basket evidence can still identify the purchase.
    const stamp = exported.resolution.timestamp;
    const [year, month, day] = stamp.raw.slice(0, 10).split('-').map(Number);
    const following = new Date(Date.UTC(year, month - 1, day + 1));
    const first = zonedDateTimeToUtc(
      { year, month, day, hour: 0, minute: 0, second: 0 },
      stamp.timezone,
    );
    const last = zonedDateTimeToUtc(
      {
        year: following.getUTCFullYear(),
        month: following.getUTCMonth() + 1,
        day: following.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      stamp.timezone,
    );
    if (!first || !last) return false;
    start = first.getTime();
    end = last.getTime() - 1;
  }
  const timestamps = sourceOrderEvidence(email).timestamps;
  if (email.resolution?.orderEvidence || timestamps.length)
    return timestamps.some((t) => {
      if (!t.instant || t.precision === 'day' || t.role === 'refund') return false;
      const time = Date.parse(t.instant);
      const precise = t.role === 'placed' || t.role === 'delivered';
      return (
        time >= start - (precise ? 1 : 6) * 3600000 && time <= end + (precise ? 4 : 6) * 3600000
      );
    });
  // Legacy timestamps have uncertain semantics; keep a broad window. Date-only
  // text is never a manufactured midnight time match.
  if (email.resolution?.timestamp?.precision === 'day' || !email.orderDate) return false;
  const time = email.orderDate.getTime();
  return time >= start - 6 * 3600000 && time <= end + 6 * 3600000;
}

function resolveGroupOrder(group: readonly SourceObservation[], id?: string): Receipt {
  const interpretations = currentSourceInterpretations(group);
  // The financial resolver selects current facts itself and needs retained sources
  // to follow revision references to an older interpretation of the same document.
  const outcome = resolveOrderOutcome(group);
  const financialSources = interpretations.filter((o) =>
    outcome.financialObservationIds.includes(o.id),
  );
  const source = (
    financialSources.find((o) => sourceOrderEvidence(o.receipt).recordedTotal !== null) ??
    financialSources[0]
  )?.receipt;
  const receipt = resolveObservations(
    interpretations.map((o) => o.receipt),
    id,
    source,
  );
  receipt.resolution!.orderOutcome = outcome;
  if (source?.resolution?.orderEvidence)
    receipt.resolution!.orderEvidence = source.resolution.orderEvidence;
  receipt.amountSpent = outcome.netAmount ?? 0;
  if (outcome.fulfillment !== 'completed') receipt.deliveryTime = undefined;
  // A disputed document must not publish an arbitrary ID or consume an export's
  // unique provider-ID slot. Its conflicting identities remain in source evidence.
  if (conflictingSourceDocuments(group).size) receipt.externalId = undefined;
  return receipt;
}

/** Whole-evidence policy: never uses prior inferred associations as identity evidence. */
export function reconcileReceiptGroups(
  input: readonly SourceObservation[],
  timezone: string,
  coverage: readonly ExportCoverage[] = [],
  // Policy 3 is exercised in shadow replay until compatible consumers are ready.
  policyVersion: 2 | 3 = RECONCILIATION_POLICY,
  reviews: readonly ReceiptReview[] = [],
): ReconciledGroup[] {
  const ordered = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const current = policyVersion === 3 ? currentSourceInterpretations(ordered) : ordered;
  const currentIds = new Set(current.map((o) => o.id));
  const conflictingDocuments =
    policyVersion === 3 ? conflictingSourceDocuments(current) : new Set<string>();
  const documentOwners = new Map<string, SourceObservation>();
  for (const o of current) {
    const key = sourceDocumentIdentity(o);
    if (!documentOwners.has(key)) documentOwners.set(key, o);
  }
  // Re-parsing a document may discover an order ID that its first observation lacked.
  // Carry that identity across copies of the same message only if it is unambiguous.
  const messageKey = (r: ReceiptWriteCommand) =>
    r.resolution?.sourceMessageId
      ? `${r.userId}:${r.receiptType}:${r.dataSource}:${r.resolution.sourceMessageId}`
      : undefined;
  const messageIds = new Map<string, Set<string>>();
  for (const o of current) {
    const key = messageKey(o.receipt),
      id = providerId(o.receipt);
    if (key && id) {
      const ids = messageIds.get(key) ?? new Set<string>();
      ids.add(id);
      messageIds.set(key, ids);
    }
  }
  const map = new Map<string, SourceObservation[]>();
  for (const o of ordered) {
    // Retain older interpretations alongside their current document, but never let
    // an obsolete ID or timezone create an order or claim another export. Equally
    // current conflicting readings stay together as one unresolved source document.
    const owner = currentIds.has(o.id) ? o : (documentOwners.get(sourceDocumentIdentity(o)) ?? o);
    const ids = messageIds.get(messageKey(owner.receipt) ?? '');
    const identified =
      !providerId(owner.receipt) && ids?.size === 1
        ? { ...owner.receipt, externalId: [...ids][0] }
        : owner.receipt;
    const document = sourceDocumentIdentity(owner);
    const k = conflictingDocuments.has(document)
      ? `conflicted-document:${document}`
      : sourceKey(identified, owner.id, policyVersion, timezone);
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  const review = reviewedAssociations([...map.values()], policyVersion === 3 ? reviews : []);
  const groups =
    policyVersion === 3
      ? groupReceiptFamilies(review.sameSourceGroups(), review.canAssociate)
      : [...map.values()];
  const disputed = groups.map((group) =>
    group.some((o) => conflictingDocuments.has(sourceDocumentIdentity(o))),
  );
  const reps = groups.map((g) => (policyVersion === 3 ? resolveGroupOrder(g) : representative(g)));
  const restaurants = reps.map((r) => restaurantIdentity(r.restaurantName));
  const dates = new Map<string, string | null>();
  const localDay = (i: number, zone: string) => {
    const key = `${i}:${zone}`;
    if (!dates.has(key)) dates.set(key, day(reps[i], zone));
    return dates.get(key);
  };
  const exports = reps
    .map((r, i) => (r.dataSource === DataSource.CSV ? i : -1))
    .filter((i) => i >= 0);
  const emails = reps
    .map((r, i) => (r.dataSource === DataSource.EMAIL ? i : -1))
    .filter((i) => i >= 0);
  const taken = new Set<number>(),
    output: ReconciledGroup[] = [];
  const sameScope = (e: number, x: number) =>
    reps[e].userId === reps[x].userId && reps[e].receiptType === reps[x].receiptType;
  const baseDay = (e: number, x: number, adjacent = false) => {
    if (
      !sameScope(e, x) ||
      !validMerchant(restaurants[e].base) ||
      restaurants[e].base !== restaurants[x].base
    )
      return false;
    const zone = reps[x].resolution?.timestamp?.timezone ?? timezone;
    const exportDay = localDay(x, zone),
      emailDay = localDay(e, zone);
    if (!exportDay || !emailDay) return false;
    if (emailDay === exportDay) return true;
    const evidence = reps[e].resolution?.orderEvidence;
    return (
      policyVersion === 3 &&
      adjacent &&
      !evidence?.orderHeaderDay &&
      !evidence?.timestamps.some((t) => t.role === 'placed') &&
      (reps[e].resolution?.timestamp?.precision === 'received' ||
        Boolean(evidence?.timestamps.some((t) => t.role === 'received'))) &&
      Math.abs(Date.parse(emailDay) - Date.parse(exportDay)) === 86400000
    );
  };
  const merchantDay = (e: number, x: number, adjacent = false) => {
    if (!baseDay(e, x, adjacent)) return false;
    const a = restaurants[e],
      b = restaurants[x];
    if (a.full === b.full) return true;
    if (a.branch && b.branch) return false;
    return (
      exports.filter((j) => baseDay(e, j, adjacent)).length === 1 &&
      emails.filter((j) => baseDay(j, x, adjacent)).length === 1
    );
  };
  const compatible = (e: number, x: number) =>
    review.canAssociate(groups[e], groups[x]) &&
    !disputed[e] &&
    !disputed[x] &&
    identityCompatible(reps[e], reps[x]) &&
    currencyCompatible(reps[e], reps[x]) &&
    (policyVersion === 2 || lifecycleCompatible(e, x));
  const lifecycleCompatible = (e: number, x: number) => {
    const a = reps[e].resolution?.orderOutcome?.fulfillment ?? 'unknown';
    const b = reps[x].resolution?.orderOutcome?.fulfillment ?? 'unknown';
    return a === 'unknown' || b === 'unknown' || a === b;
  };
  const join = (e: number, x: number, method: ReconciledGroup['method']) => {
    taken.add(e);
    taken.add(x);
    output.push({
      observations: [...groups[x], ...groups[e]],
      method,
      ...(policyVersion === 3 ? { policyVersion } : {}),
    });
  };
  for (const indices of review.mergedIndices(groups)) {
    if (indices.length === 1) continue;
    indices.forEach((i) => taken.add(i));
    output.push({
      observations: indices.flatMap((i) => groups[i]),
      method: 'reviewed',
      policyVersion: 3,
    });
  }
  for (const e of emails) {
    if (disputed[e] || taken.has(e)) continue;
    const xs = exports.filter(
      (x) =>
        !disputed[x] &&
        review.canAssociate(groups[e], groups[x]) &&
        sameScope(e, x) &&
        providerId(reps[e]) &&
        providerId(reps[e]) === providerId(reps[x]),
    );
    if (xs.length === 1 && !taken.has(xs[0])) join(e, xs[0], 'identity');
  }
  // Candidate cardinalities always include the original full group, even after joins.
  const candidates = new Map<number, number[]>();
  for (const e of emails)
    candidates.set(
      e,
      exports.filter((x) => merchantDay(e, x, policyVersion === 3) && compatible(e, x)),
    );
  const evidence = (e: number, x: number, method: ReconciledGroup['method']): boolean => {
    const sameRestaurantExports = exports.filter((j) => merchantDay(e, j));
    const sameRestaurantEmails = emails.filter((j) => merchantDay(j, x));
    if (method === 'unique_day')
      return (
        merchantDay(e, x) &&
        (policyVersion === 2 || hasOrderSnapshot(reps[e])) &&
        sameRestaurantExports.length === 1 &&
        sameRestaurantEmails.length === 1
      );
    const a = reps[e],
      b = reps[x];
    if (policyVersion === 3 && !hasOrderSnapshot(a) && method !== 'lifecycle_amount') return false;
    if (method === 'lifecycle_amount' || method === 'final_amount') {
      const email = a.resolution?.orderOutcome;
      const exported = b.resolution?.orderOutcome;
      const knownCurrency =
        a.monetaryDetails?.currencyCode &&
        a.monetaryDetails.currencyCode !== 'UNKNOWN' &&
        a.monetaryDetails.currencyCode === b.monetaryDetails?.currencyCode;
      if (
        !knownCurrency ||
        b.resolution?.amountBasis === 'item_subtotal' ||
        email?.netAmount === null ||
        exported?.netAmount === null ||
        email?.netAmount === undefined ||
        exported?.netAmount === undefined
      )
        return false;
      if (Math.abs(Math.round(email.netAmount * 100) - Math.round(exported.netAmount * 100)) > 1)
        return false;
      if (method === 'final_amount') return email.netAmount > 0 && exported.netAmount > 0;
      return (
        (email.refundStatus === 'full' &&
          exported.fulfillment === 'completed' &&
          exported.netAmount === 0) ||
        (email.fulfillment === 'canceled' && exported.fulfillment === 'canceled')
      );
    }
    if (method === 'basket')
      return Boolean(a.items.length && b.items.length && basket(a) === basket(b));
    const as = a.monetaryDetails?.subtotal,
      bs = b.resolution?.reconstructedSubtotal ?? b.monetaryDetails?.subtotal;
    return as !== undefined && bs !== undefined && Math.abs(as - bs) <= 0.010001;
  };
  const methods =
    policyVersion === 3
      ? (['lifecycle_amount', 'unique_day', 'final_amount', 'basket', 'subtotal'] as const)
      : (['unique_day', 'basket', 'subtotal'] as const);
  for (const method of methods) {
    for (const e of emails) {
      if (taken.has(e)) continue;
      const xs = (candidates.get(e) ?? []).filter((x) => evidence(e, x, method));
      if (xs.length !== 1 || taken.has(xs[0])) continue;
      const x = xs[0];
      if (
        emails.filter((j) => candidates.get(j)?.includes(x) && evidence(j, x, method)).length === 1
      )
        join(e, x, method);
    }
  }
  const nearest = (values: number[], distance: (i: number) => number) => {
    const sorted = values
      .map((i) => ({ i, d: distance(i) }))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    return sorted.length &&
      sorted[0].d <= 2 * 3600000 &&
      (sorted.length === 1 || sorted[1].d - sorted[0].d >= 3600000)
      ? sorted[0].i
      : undefined;
  };
  for (const e of emails) {
    if (taken.has(e)) continue;
    if (policyVersion === 3) {
      if (!hasOrderSnapshot(reps[e])) continue;
      const eligible = (candidates.get(e) ?? []).filter(
        (x) => merchantDay(e, x) && withinOrderWindow(reps[e], reps[x]),
      );
      if (eligible.length !== 1 || taken.has(eligible[0])) continue;
      const x = eligible[0];
      if (
        emails.filter(
          (j) =>
            candidates.get(j)?.includes(x) &&
            merchantDay(j, x) &&
            withinOrderWindow(reps[j], reps[x]),
        ).length === 1
      )
        join(e, x, 'time');
      continue;
    }
    const x = nearest(candidates.get(e) ?? [], (i) => timeDistance(reps[e], reps[i]));
    if (x === undefined || taken.has(x)) continue;
    const reverse = nearest(
      emails.filter((j) => candidates.get(j)?.includes(x)),
      (j) => timeDistance(reps[j], reps[x]),
    );
    if (reverse === e) join(e, x, 'time');
  }
  for (let i = 0; i < groups.length; i++) {
    if (taken.has(i)) continue;
    let reason: ReconciledGroup['reason'];
    if (reps[i].dataSource === DataSource.EMAIL) {
      const potential = exports.filter((x) => merchantDay(i, x, policyVersion === 3));
      const date = localDay(i, timezone);
      const boundary = (value: string) =>
        value.length === 10 ? value : getLocalDateKey(new Date(value), timezone);
      const ranges = coverage.filter(
        (c) =>
          c.provider === reps[i].receiptType &&
          date &&
          boundary(c.start) &&
          boundary(c.end) &&
          date >= boundary(c.start)! &&
          date <= boundary(c.end)!,
      );
      if (potential.length)
        reason = potential.every((x) => !identityCompatible(reps[i], reps[x]))
          ? 'identity_conflict'
          : potential.every((x) => !currencyCompatible(reps[i], reps[x]))
            ? 'currency_conflict'
            : policyVersion === 3 && potential.every((x) => !lifecycleCompatible(i, x))
              ? 'lifecycle_conflict'
              : 'ambiguous';
      else if (ranges.length)
        reason = ranges.some((c) => c.incomplete) ? 'incomplete_export' : 'no_export_candidate';
    }
    if (policyVersion === 3 && reps[i].resolution?.orderOutcome?.kind === 'unlinked_adjustment')
      reason = 'unlinked_adjustment';
    if (disputed[i]) reason = 'identity_conflict';
    if (review.isBlocked(groups[i])) reason = 'review_conflict';
    output.push({
      observations: groups[i],
      method:
        policyVersion === 3 &&
        !disputed[i] &&
        groups[i].length > 1 &&
        reps[i].dataSource === DataSource.EMAIL
          ? 'receipt_family'
          : 'standalone',
      ...(reason ? { reason } : {}),
      ...(policyVersion === 3 ? { policyVersion } : {}),
    });
  }
  for (const group of output) {
    const ids = review.reviewIds(group.observations);
    if (ids.length) group.reviewIds = ids;
    const invalid = ids.filter((id) => review.invalidReviewIds.includes(id));
    if (invalid.length) group.invalidReviewIds = invalid;
    if (!group.reason && review.mergedIndices([group.observations]).length)
      group.method = 'reviewed';
  }
  return output.sort((a, b) =>
    a.observations
      .map((o) => o.id)
      .sort()[0]
      .localeCompare(b.observations.map((o) => o.id).sort()[0]),
  );
}

export function projectReconciledGroup(group: ReconciledGroup, id: string): Receipt {
  const result =
    group.policyVersion === 3
      ? resolveGroupOrder(group.observations, id)
      : resolveObservations(
          group.observations.map((o) => o.receipt),
          id,
        );
  result.resolution!.reconciliation = {
    policyVersion: group.policyVersion ?? RECONCILIATION_POLICY,
    status: group.reason ? 'unresolved' : group.method === 'standalone' ? 'standalone' : 'merged',
    method: group.method,
    observationIds: group.observations.map((o) => o.id).sort(),
    ...(group.reviewIds?.length ? { reviewIds: group.reviewIds } : {}),
    ...(group.invalidReviewIds?.length ? { invalidReviewIds: group.invalidReviewIds } : {}),
    ...(group.reason ? { reason: group.reason } : {}),
  };
  return result;
}
