import type { ReceiptWriteCommand } from '../../models/Receipt';
import type {
  OrderFinancialEvent,
  OrderOutcome,
  OrderSourceEvidence,
} from '../../models/OrderEvidence';
import { moneySum } from '../../models/ReceiptResolution';
import {
  currentSourceInterpretations,
  sourceDocumentIdentity,
} from './ReceiptSourceInterpretations';
import { paymentSnapshotKey, resolvePaymentEvents } from './OrderPaymentEvents';
import { recordedItemPrice, usableItemUnitPrice } from './ItemPrice';

export interface OrderObservation {
  id: string;
  receipt: ReceiptWriteCommand;
}
interface Snapshot {
  ids: string[];
  referenceIds: string[];
  receipt: ReceiptWriteCommand;
  evidence: OrderSourceEvidence;
  /** Earliest observed copy bounds when this balance was already known. */
  receivedAt: number | null;
}
const minor = (value: number) => Math.round(value * 100);
const equal = (a: number, b: number) => minor(a) === minor(b);
const unique = <T>(values: readonly T[]) => [...new Set(values)];

/** Old observations remain usable but do not acquire facts their parser discarded. */
export function sourceOrderEvidence(receipt: ReceiptWriteCommand): OrderSourceEvidence {
  if (receipt.resolution?.orderEvidence) return receipt.resolution.orderEvidence;
  return {
    version: 1,
    parserVersion: 3,
    documentKind: receipt.dataSource === 'csv' ? 'export' : 'original',
    fulfillment: 'unknown',
    timestamps: [],
    recordedTotal: receipt.amountSpent,
    totalState: 'known',
    payments: [],
    issues: ['Legacy observation lacks order-event evidence'],
  };
}

function snapshots(input: readonly OrderObservation[]): Snapshot[] {
  const grouped = new Map<string, Snapshot>();
  const documentReferences = new Map<string, Set<string>>();
  for (const observation of input) {
    const key = sourceDocumentIdentity(observation);
    const references = documentReferences.get(key) ?? new Set<string>();
    references.add(observation.id);
    const messageId = observation.receipt.resolution?.sourceMessageId;
    if (messageId) references.add(messageId);
    documentReferences.set(key, references);
  }
  for (const observation of currentSourceInterpretations(input).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const evidence = sourceOrderEvidence(observation.receipt);
    const received = evidence.timestamps.flatMap((timestamp) =>
      timestamp.role === 'received' && timestamp.precision !== 'day' && timestamp.instant
        ? [Date.parse(timestamp.instant)]
        : [],
    );
    const receivedAt = received.length ? Math.min(...received) : null;
    // A revision can reference an older interpretation's observation ID. Keep that
    // alias without reviving its stale financial facts or claiming it as price evidence.
    const referenceIds = [...(documentReferences.get(sourceDocumentIdentity(observation)) ?? [])];
    // Received time does not make a forwarded/retried financial snapshot a new revision.
    const key = JSON.stringify([
      observation.receipt.dataSource,
      evidence.documentKind,
      evidence.fulfillment,
      evidence.recordedTotal,
      evidence.previousTotal,
      evidence.refundAmount,
      evidence.refundConfirmed,
      evidence.refundReference,
      evidence.refundDestination,
      evidence.revisionOf,
      evidence.payments.map(paymentSnapshotKey).sort(),
      evidence.promotionExplainsZero,
      evidence.timestamps.filter((t) => t.role !== 'received'),
      observation.receipt.monetaryDetails?.currencyCode,
    ]);
    const previous = grouped.get(key);
    if (previous) {
      previous.ids.push(observation.id);
      previous.referenceIds = unique([...previous.referenceIds, ...referenceIds]);
      // Scope enrichment is not another monetary revision. Retain contradictory
      // descriptions without mutating either immutable source interpretation.
      if (evidence.refundScope) {
        const scope = previous.evidence.refundScope;
        previous.evidence = {
          ...previous.evidence,
          refundScope:
            scope && scope !== evidence.refundScope ? 'conflicted' : evidence.refundScope,
        };
      }
      if (receivedAt !== null)
        previous.receivedAt =
          previous.receivedAt === null ? receivedAt : Math.min(previous.receivedAt, receivedAt);
    } else
      grouped.set(key, {
        ids: [observation.id],
        referenceIds,
        receipt: observation.receipt,
        evidence,
        receivedAt,
      });
  }
  return [...grouped.values()];
}

const referencesSnapshot = (snapshot: Snapshot, reference: string): boolean =>
  snapshot.referenceIds.includes(reference);

/** Preserve explicit order-level scope without deriving missing balances or payment amounts. */
function applyDeclaredRefundScope(
  result: OrderOutcome,
  sources: readonly Snapshot[],
  chain: readonly Snapshot[],
): void {
  if (result.financialConfidence === 'conflicted' || result.refundStatus === 'reversed') return;
  const latest = chain[chain.length - 1];
  const declared = sources.filter((source) => source.evidence.refundScope !== undefined);
  if (!declared.length) return;
  const cyclic = declared.some((source) =>
    sources.some(
      (other) =>
        other !== source &&
        explicitlyFollowsBalance(other, source, sources) &&
        explicitlyFollowsBalance(source, other, sources),
    ),
  );
  const current = declared.filter(
    (source) =>
      !sources.some(
        (other) =>
          other !== source &&
          ((other === latest && chain.includes(source)) ||
            (explicitlyFollowsBalance(other, source, sources) &&
              !explicitlyFollowsBalance(source, other, sources))),
      ),
  );
  if (!current.length && !cyclic) return;
  result.financialObservationIds = unique([
    ...result.financialObservationIds,
    ...current.flatMap((source) => source.ids),
  ]).sort();
  const scopes = unique(current.map((source) => source.evidence.refundScope!));
  const latestScope = latest?.evidence.refundScope;
  const contradictsBalance =
    (latestScope === 'full' &&
      latest.evidence.recordedTotal !== null &&
      latest.evidence.recordedTotal > 0) ||
    (latestScope === 'partial' &&
      latest.evidence.recordedTotal === 0 &&
      (latest.evidence.previousTotal ?? 0) > 0);
  const refundEvents = result.events.filter(
    (event) => event.kind === 'refund' && event.confidence === 'confirmed',
  );
  const contradictsPayment =
    scopes.length === 1 &&
    scopes[0] !== result.refundStatus &&
    ['full', 'partial'].includes(result.refundStatus) &&
    refundEvents.length === 1 &&
    current.some(
      (source) =>
        source.ids.some((id) => refundEvents[0].observationIds.includes(id)) ||
        Boolean(
          source.evidence.refundReference &&
          source.evidence.refundReference === refundEvents[0].reference,
        ),
    );
  if (
    cyclic ||
    scopes.includes('conflicted') ||
    (scopes.length > 1 && !['full', 'partial'].includes(result.refundStatus)) ||
    contradictsBalance ||
    contradictsPayment
  ) {
    // Refund occurrence may be confirmed while its extent is disputed. An independently
    // stated monetary balance remains available; this is not a fabricated money conflict.
    result.refundStatus = 'conflicted';
    result.refundConfidence = 'confirmed';
    result.issues.push(
      cyclic
        ? 'Cyclic refund-scope revisions require review'
        : 'Conflicting explicit refund scope requires review',
    );
    return;
  }
  const scope = scopes[0];
  if (scope !== 'full' && scope !== 'partial') return;
  if (['full', 'partial', 'conflicted'].includes(result.refundStatus)) {
    // A partial installment can precede a fully refunded balance. Do not overwrite
    // established money/chronology using a notice with no independent revision link.
    if (result.refundStatus !== scope)
      result.issues.push(
        'Reported refund scope differs from the resolved balance; notice order is not established',
      );
    return;
  }
  result.refundStatus = scope;
  result.refundConfidence = 'confirmed';
  result.estimatedRefundAmount = null;
  result.events = result.events.filter(
    (event) => !(event.kind === 'refund' && event.confidence === 'inferred'),
  );
  if (result.confirmedRefundAmount === null)
    result.issues.push('Provider states refund scope; refund amount remains unknown');
}

function explicitlyFollowsBalance(
  source: Snapshot,
  latest: Snapshot,
  adjustments: readonly Snapshot[],
): boolean {
  const visited = new Set<Snapshot>();
  let current = source;
  while (!visited.has(current)) {
    visited.add(current);
    const reference = current.evidence.revisionOf;
    if (!reference) return false;
    if (referencesSnapshot(latest, reference)) return true;
    const parents = adjustments.filter((candidate) => referencesSnapshot(candidate, reference));
    if (parents.length !== 1) return false;
    current = parents[0];
  }
  return false;
}

function revisions(sources: Snapshot[]): { chain: Snapshot[]; conflict: boolean } {
  const edits = sources.filter(
    (s) =>
      ['updated', 'refund'].includes(s.evidence.documentKind) && s.evidence.recordedTotal !== null,
  );
  if (!edits.length) return { chain: [], conflict: false };
  const previous = (edit: Snapshot): Snapshot[] => {
    const e = edit.evidence;
    if (e.revisionOf)
      return sources.filter((s) => s !== edit && referencesSnapshot(s, e.revisionOf!));
    if (e.previousTotal === undefined) return [];
    return sources.filter(
      (s) =>
        s !== edit &&
        s.evidence.documentKind !== 'export' &&
        s.evidence.recordedTotal !== null &&
        equal(s.evidence.recordedTotal, e.previousTotal!),
    );
  };
  // A revision may reference an intervening refund notice rather than the last
  // balance directly. Walk those links before deciding which balance is latest.
  const used = new Set<Snapshot>();
  for (const edit of edits) {
    const pending = [...previous(edit)];
    const visited = new Set<Snapshot>();
    while (pending.length) {
      const ancestor = pending.pop()!;
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      used.add(ancestor);
      pending.push(...previous(ancestor));
    }
  }
  const ends = edits.filter((s) => !used.has(s));
  if (ends.length !== 1) return { chain: [], conflict: true };
  const path: Snapshot[] = [];
  let current: Snapshot | undefined = ends[0];
  while (current) {
    if (path.includes(current)) return { chain: [], conflict: true };
    path.unshift(current);
    const parents: Snapshot[] = previous(current);
    if (parents.length > 1) return { chain: [], conflict: true };
    current = parents[0];
  }
  // A competing branch cannot disappear merely because another chain is longer.
  if (edits.some((s) => !path.includes(s))) return { chain: [], conflict: true };
  return { chain: path, conflict: false };
}

/** Separate new adjustments from payment notices already included in a receipt balance. */
function additionalEventsSinceBalance(
  latest: Snapshot,
  balanceSources: readonly Snapshot[],
  adjustments: readonly Snapshot[],
  events: readonly OrderFinancialEvent[],
  balanceRefunds: number | null,
  balanceIncreases: number,
): Set<string> {
  const balanceIds = new Set(balanceSources.flatMap((source) => source.ids));
  const included = events.filter((event) => event.observationIds.some((id) => balanceIds.has(id)));
  const includedAdjustments = included.filter((event) => event.kind !== 'charge');
  // A later settlement date alone does not prove another refund. The preceding
  // balance must already be fully explained by independently identified events.
  const identifiedBalance =
    balanceRefunds !== null &&
    includedAdjustments.every((event) => Boolean(event.reference)) &&
    equal(
      moneySum(included.filter((event) => event.kind === 'refund').map((event) => event.amount)),
      balanceRefunds,
    ) &&
    equal(
      moneySum(
        included
          .filter((event) => ['refund_reversal', 'charge_adjustment'].includes(event.kind))
          .map((event) => event.amount),
      ),
      balanceIncreases,
    );
  return new Set(
    events
      .filter((event) => {
        if (event.kind === 'charge' || event.observationIds.some((id) => balanceIds.has(id)))
          return false;
        const linkedAfter = adjustments.some(
          (source) =>
            source.ids.some((id) => event.observationIds.includes(id)) &&
            explicitlyFollowsBalance(source, latest, adjustments),
        );
        if (linkedAfter) return true;
        return Boolean(
          event.reference &&
          identifiedBalance &&
          latest.receivedAt !== null &&
          event.timestamp?.role === 'refund' &&
          event.timestamp.precision !== 'day' &&
          event.timestamp.instant &&
          Date.parse(event.timestamp.instant) > latest.receivedAt,
        );
      })
      .map((event) => event.key),
  );
}

/** Resolves a single, already-associated order. It never adds source totals together. */
export function resolveOrderOutcome(input: readonly OrderObservation[]): OrderOutcome {
  if (!input.length) throw new Error('Order outcome requires source evidence');
  const sources = snapshots(input);
  const exports = sources.filter((s) => s.evidence.documentKind === 'export');
  const originals = sources.filter((s) => s.evidence.documentKind === 'original');
  const cancellations = sources.filter((s) => s.evidence.documentKind === 'cancellation');
  const adjustments = sources
    .filter(
      (s) =>
        ['refund', 'updated'].includes(s.evidence.documentKind) &&
        s.evidence.recordedTotal === null,
    )
    .map((source) => ({
      ...source,
      evidence: {
        ...source.evidence,
        payments:
          source.evidence.refundAmount !== undefined &&
          !source.evidence.payments.some((p) => p.kind === 'refund')
            ? [
                ...source.evidence.payments,
                {
                  kind: 'refund' as const,
                  amount: source.evidence.refundAmount,
                  tender: source.evidence.refundDestination ?? ('unknown' as const),
                },
              ]
            : source.evidence.payments,
      },
    }));
  const statuses = unique(
    sources.map((s) => s.evidence.fulfillment).filter((s) => s !== 'unknown'),
  );
  const currencies = unique(
    sources
      .flatMap((s) => [
        s.receipt.monetaryDetails?.currencyCode,
        ...s.evidence.payments.map((p) => p.currencyCode),
      ])
      .filter((c) => c && c !== 'UNKNOWN'),
  );
  const hasOrder = exports.length > 0 || originals.length > 0 || cancellations.length > 0;
  const result: OrderOutcome = {
    version: 3,
    kind: hasOrder ? 'order' : 'unlinked_adjustment',
    fulfillment: statuses.length === 1 ? statuses[0] : 'unknown',
    fulfillmentConfidence:
      statuses.length > 1 ? 'conflicted' : statuses.length ? 'confirmed' : 'unknown',
    refundStatus: 'none_established',
    refundConfidence: 'unknown',
    originalCharge: null,
    netAmount: null,
    confirmedRefundAmount: null,
    estimatedRefundAmount: null,
    cancellationCharge: null,
    financialConfidence: 'unknown',
    financialObservationIds: [],
    events: [],
    issues: unique(sources.flatMap((s) => s.evidence.issues)),
  };
  if (statuses.length > 1) result.issues.push('Conflicting fulfillment evidence');
  if (currencies.length > 1) {
    result.financialConfidence = 'conflicted';
    result.refundStatus = 'conflicted';
    result.refundConfidence = 'conflicted';
    result.issues.push('Conflicting currencies; amounts cannot be combined');
    return result;
  }

  const edits = revisions(sources);
  if (edits.conflict) {
    result.financialConfidence = 'conflicted';
    result.refundStatus = 'conflicted';
    result.refundConfidence = 'conflicted';
    result.issues.push('Competing or cyclic receipt revisions require review');
    return result;
  }
  const latest = edits.chain[edits.chain.length - 1];
  const completedZero = exports.filter(
    (s) =>
      s.evidence.fulfillment === 'completed' &&
      s.evidence.recordedTotal === 0 &&
      s.receipt.resolution?.amountBasis === 'export_total',
  );
  const positiveItems = completedZero.some((s) =>
    s.receipt.items.some((item) =>
      (usableItemUnitPrice(item, s.receipt) ?? recordedItemPrice(item) ?? 0) > 0 && item.quantity > 0,
    ),
  );
  const explainedZero = sources.some((s) => s.evidence.promotionExplainsZero);
  const inferredZero = completedZero.length > 0 && !explainedZero;
  const preferred = latest
    ? [latest]
    : cancellations.length
      ? cancellations
      : inferredZero
        ? completedZero
        : originals.some((s) => s.evidence.recordedTotal !== null)
          ? originals
          : exports;
  const amounts = unique(
    preferred.flatMap((s) =>
      s.evidence.recordedTotal === null || s.receipt.resolution?.amountBasis === 'item_subtotal'
        ? []
        : [s.evidence.recordedTotal],
    ),
  );
  result.financialObservationIds = preferred.flatMap((s) => s.ids).sort();
  if (amounts.length > 1) {
    result.financialConfidence = 'conflicted';
    result.issues.push('Conflicting source snapshots have no identifiable revision order');
    return result;
  }
  result.netAmount = amounts[0] ?? null;
  result.financialConfidence =
    result.netAmount === null
      ? 'unknown'
      : preferred.every((s) => s.evidence.documentKind === 'export')
        ? 'inferred'
        : 'confirmed';
  const root = edits.chain[0];
  const originalAmounts = unique(
    originals.flatMap((s) => (s.evidence.recordedTotal === null ? [] : [s.evidence.recordedTotal])),
  );
  result.originalCharge =
    root?.evidence.previousTotal ??
    (root && ['original', 'cancellation'].includes(root.evidence.documentKind)
      ? root.evidence.recordedTotal
      : null) ??
    (originalAmounts.length === 1 ? originalAmounts[0] : null);
  if (result.originalCharge === null && (cancellations.length || (!latest && !inferredZero)))
    result.originalCharge = result.netAmount;
  if (result.fulfillment === 'canceled') result.cancellationCharge = result.netAmount;

  // Restrict snapshots to the established chain (and its original); a forwarded old
  // original cannot undo a revised balance or add another payment.
  const balanceSources = latest
    ? edits.chain
    : inferredZero && originals.length
      ? originals
      : preferred;
  const payments = resolvePaymentEvents([...balanceSources, ...adjustments]);
  result.events = payments.events;
  const adjustmentPayments = resolvePaymentEvents(adjustments);
  const adjustmentRefunds = adjustmentPayments.events.filter((event) => event.kind === 'refund');
  const ambiguousInstallments =
    adjustmentRefunds.length > 1 &&
    adjustmentRefunds.some(
      (event) =>
        !event.reference &&
        !(
          event.timestamp?.role === 'refund' &&
          event.timestamp.instant &&
          event.timestamp.precision !== 'day'
        ),
    );
  if (payments.conflict || ambiguousInstallments) {
    if (ambiguousInstallments) {
      const uncertainIds = new Set(adjustments.flatMap((source) => source.ids));
      result.events = result.events.map((event) =>
        event.kind === 'refund' && event.observationIds.some((id) => uncertainIds.has(id))
          ? { ...event, confidence: 'conflicted' }
          : event,
      );
    }
    result.financialConfidence = 'conflicted';
    result.netAmount = null;
    result.cancellationCharge = null;
    result.refundStatus = 'conflicted';
    result.refundConfidence = 'conflicted';
    result.issues.push(
      ambiguousInstallments
        ? 'Refund notices lack distinct installment identities or event times'
        : 'Conflicting or ambiguous payment identities',
    );
    return result;
  }
  const refundEvents = () =>
    moneySum(result.events.filter((e) => e.kind === 'refund').map((e) => e.amount));
  const reversals = () =>
    moneySum(result.events.filter((e) => e.kind === 'refund_reversal').map((e) => e.amount));
  const addBalanceEvent = (
    kind: OrderFinancialEvent['kind'],
    amount: number,
    confidence: OrderFinancialEvent['confidence'],
    observationIds: string[],
    tender: OrderFinancialEvent['tender'] = 'unknown',
  ) => {
    if (amount <= 0) return;
    result.events.push({
      key: `balance:${kind}:${minor(amount)}:${observationIds.join(',')}`,
      kind,
      amount,
      tender,
      confidence,
      observationIds: [...observationIds].sort(),
    });
  };
  const knownCharges = moneySum(
    result.events.filter((e) => e.kind === 'charge').map((e) => e.amount),
  );
  if (result.originalCharge !== null && knownCharges === 0)
    addBalanceEvent(
      'charge',
      result.originalCharge,
      originals.length || latest || cancellations.length ? 'confirmed' : 'inferred',
      root?.ids ?? result.financialObservationIds,
    );
  else if (result.originalCharge !== null && !equal(knownCharges, result.originalCharge))
    result.issues.push('Payment allocations do not reconcile with original charge');

  if (latest && result.netAmount !== null) {
    const transitions = edits.chain.filter(
      (s) => s.evidence.previousTotal !== undefined && s.evidence.recordedTotal !== null,
    );
    const reductions = moneySum(
      transitions.map((s) => Math.max(0, s.evidence.previousTotal! - s.evidence.recordedTotal!)),
    );
    const increases = moneySum(
      transitions.map((s) => Math.max(0, s.evidence.recordedTotal! - s.evidence.previousTotal!)),
    );
    const explicit = latest.evidence.refundAmount;
    const establishedReduction = transitions.length
      ? reductions
      : result.originalCharge !== null
        ? Math.max(0, moneySum([result.originalCharge, -result.netAmount, increases]))
        : (explicit ?? null);
    const additional = additionalEventsSinceBalance(
      latest,
      balanceSources,
      adjustments,
      result.events,
      establishedReduction,
      increases,
    );
    const sumAdditional = (kind: OrderFinancialEvent['kind']) =>
      moneySum(
        result.events
          .filter((event) => additional.has(event.key) && event.kind === kind)
          .map((event) => event.amount),
      );
    const addedRefunds = sumAdditional('refund');
    const addedReversals = sumAdditional('refund_reversal');
    const addedCharges = sumAdditional('charge_adjustment');
    const includedRefunds = moneySum([refundEvents(), -addedRefunds]);
    const includedReversals = moneySum([reversals(), -addedReversals]);
    const otherIncreases = moneySum(
      result.events
        .filter((e) => e.kind === 'charge_adjustment' && !additional.has(e.key))
        .map((e) => e.amount),
    );
    const refundAmount =
      reductions ||
      (result.originalCharge !== null
        ? Math.max(0, moneySum([result.originalCharge, -result.netAmount, increases]))
        : (explicit ?? includedRefunds));
    const net = moneySum([result.netAmount, addedReversals, addedCharges, -addedRefunds]);
    if (
      net < 0 ||
      reversals() > moneySum([Math.max(refundAmount, includedRefunds), addedRefunds]) ||
      (result.originalCharge !== null &&
        minor(moneySum([includedReversals, otherIncreases])) > minor(increases))
    ) {
      result.financialConfidence = 'conflicted';
      result.netAmount = null;
      result.cancellationCharge = null;
      result.refundStatus = 'conflicted';
      result.refundConfidence = 'conflicted';
      result.issues.push('Additional adjustments conflict with the revised order balance');
      return result;
    }
    if (refundAmount > 0 || refundEvents() > 0) {
      if (includedRefunds > refundAmount && result.originalCharge !== null) {
        result.financialConfidence = 'conflicted';
        result.netAmount = null;
        result.cancellationCharge = null;
        result.refundStatus = 'conflicted';
        result.refundConfidence = 'conflicted';
        result.issues.push(
          'Refund payment snapshots exceed receipt revision reductions; adjustment timing requires review',
        );
        return result;
      } else
        addBalanceEvent(
          'refund',
          moneySum([refundAmount, -includedRefunds]),
          'confirmed',
          transitions.flatMap((s) => s.ids).length ? transitions.flatMap((s) => s.ids) : latest.ids,
          latest.evidence.refundDestination,
        );
      result.confirmedRefundAmount = moneySum([
        Math.max(refundAmount, includedRefunds),
        addedRefunds,
      ]);
      result.refundStatus =
        reversals() >= result.confirmedRefundAmount
          ? 'reversed'
          : result.originalCharge === null
            ? 'confirmed_unclassified'
            : net === 0 && result.originalCharge > 0
              ? 'full'
              : 'partial';
      result.refundConfidence = 'confirmed';
    }
    if (increases > includedReversals + otherIncreases)
      addBalanceEvent(
        'charge_adjustment',
        moneySum([increases, -includedReversals, -otherIncreases]),
        'confirmed',
        transitions.flatMap((s) => s.ids),
      );
    result.netAmount = net;
    if (result.fulfillment === 'canceled') result.cancellationCharge = net;
    result.financialObservationIds = unique([
      ...result.financialObservationIds,
      ...adjustments.flatMap((source) => source.ids),
    ]).sort();
  } else if (adjustments.length && result.events.some((e) => e.kind !== 'charge')) {
    result.financialObservationIds = unique([
      ...result.financialObservationIds,
      ...adjustments.flatMap((s) => s.ids),
    ]).sort();
    if (result.originalCharge === null) {
      // A confirmed event does not establish the original charge or whether the
      // refund was full/partial. A recorded zero export remains a known snapshot,
      // but we cannot subtract its refund again or reconstruct a missing charge.
      const unknownIncreases = result.events.some(
        (event) =>
          ['refund_reversal', 'charge_adjustment'].includes(event.kind) && event.amount > 0,
      );
      const supportedZero = inferredZero && !unknownIncreases;
      result.netAmount = supportedZero ? 0 : null;
      result.financialConfidence = supportedZero ? 'inferred' : 'unknown';
      if (inferredZero && unknownIncreases)
        result.issues.push(
          'Later charges or reversals cannot be sequenced against the zero export',
        );
      if (refundEvents() > 0) {
        result.confirmedRefundAmount = refundEvents();
        result.refundStatus = equal(reversals(), refundEvents())
          ? 'reversed'
          : 'confirmed_unclassified';
        result.refundConfidence = 'confirmed';
      }
      if (reversals() > refundEvents()) {
        result.netAmount = null;
        result.financialConfidence = 'conflicted';
        result.refundStatus = 'conflicted';
        result.refundConfidence = 'conflicted';
        result.issues.push('Refund reversal exceeds established refund events');
      }
      result.issues.push('Refund event retained; original order balance is not established');
    } else {
      const addedCharges = moneySum(
        result.events.filter((e) => e.kind === 'charge_adjustment').map((e) => e.amount),
      );
      const net = moneySum([result.originalCharge, addedCharges, reversals(), -refundEvents()]);
      if (net < 0 || reversals() > refundEvents() || (inferredZero && net !== 0)) {
        result.netAmount = null;
        result.cancellationCharge = null;
        result.financialConfidence = 'conflicted';
        result.refundStatus = 'conflicted';
        result.refundConfidence = 'conflicted';
        result.issues.push('Refund events conflict with the established order balance');
      } else {
        result.netAmount = net;
        result.financialConfidence =
          originals.length || cancellations.length ? 'confirmed' : 'inferred';
        if (result.fulfillment === 'canceled') result.cancellationCharge = net;
        if (refundEvents() > 0) {
          result.confirmedRefundAmount = refundEvents();
          result.refundStatus =
            reversals() === refundEvents() ? 'reversed' : net === 0 ? 'full' : 'partial';
          result.refundConfidence = 'confirmed';
        }
      }
    }
  } else if (inferredZero && !latest) {
    result.refundStatus = positiveItems ? 'probable_full' : 'zero_unexplained';
    result.refundConfidence = positiveItems ? 'inferred' : 'unknown';
    result.estimatedRefundAmount =
      positiveItems && result.originalCharge !== null && result.originalCharge > 0
        ? result.originalCharge
        : null;
    if (result.estimatedRefundAmount !== null)
      addBalanceEvent(
        'refund',
        result.estimatedRefundAmount,
        'inferred',
        unique([...completedZero.flatMap((s) => s.ids), ...originals.flatMap((s) => s.ids)]),
      );
    result.issues.push(
      positiveItems
        ? 'Likely refund inferred from completed zero export; not confirmed'
        : 'Zero total has no established explanation',
    );
  }
  const unquantified = sources.filter(
    (source) =>
      source.evidence.refundConfirmed === true &&
      source.evidence.refundAmount === undefined &&
      !source.evidence.payments.some((event) => event.kind === 'refund'),
  );
  if (unquantified.length && result.financialConfidence !== 'conflicted') {
    result.financialObservationIds = unique([
      ...result.financialObservationIds,
      ...unquantified.flatMap((source) => source.ids),
    ]).sort();
    const knownRefundReferences = result.events
      .filter(
        (event) => event.kind === 'refund' && event.confidence === 'confirmed' && event.reference,
      )
      .map((event) => event.reference);
    const unaccounted = unquantified.filter((source) => {
      const reference = source.evidence.refundReference;
      if (reference && knownRefundReferences.includes(reference)) return false;
      // A later identifiable balance can settle an earlier amount-less notice.
      if (latest && source !== latest && edits.chain.includes(source))
        return result.confirmedRefundAmount === null || result.confirmedRefundAmount === 0;
      // A distinct reference or explicit successor cannot disappear into an older refund.
      if (latest && explicitlyFollowsBalance(source, latest, adjustments)) return true;
      if (reference && knownRefundReferences.length && !knownRefundReferences.includes(reference))
        return true;
      // Without evidence of a separate event, a confirmation can corroborate the
      // established refund. Never create another debit merely from its arrival time.
      return result.confirmedRefundAmount === null || result.confirmedRefundAmount === 0;
    });
    if (unaccounted.length) {
      const balanceIncludesConfirmation =
        latest &&
        unaccounted.every(
          (source) =>
            edits.chain.includes(source) && !explicitlyFollowsBalance(source, latest, adjustments),
        );
      const supportedZero =
        !latest &&
        inferredZero &&
        !result.events.some(
          (event) =>
            ['refund_reversal', 'charge_adjustment'].includes(event.kind) && event.amount > 0,
        );
      result.refundStatus = 'confirmed_unclassified';
      result.refundConfidence = 'confirmed';
      result.confirmedRefundAmount = null;
      result.estimatedRefundAmount = null;
      // A zero export can support zero net cost, not the missing refund dollars.
      // A revised receipt can independently state net cost without stating the refund.
      if (!balanceIncludesConfirmation && !supportedZero) {
        result.netAmount = null;
        result.cancellationCharge = null;
        result.financialConfidence = 'unknown';
      }
      result.events = result.events.filter(
        (event) => !(event.kind === 'refund' && event.confidence === 'inferred'),
      );
      result.issues.push('Refund confirmed; amount is not established');
    }
  }
  applyDeclaredRefundScope(result, sources, edits.chain);
  if (result.netAmount !== null && result.events.length) {
    const ledgerNet = moneySum(
      result.events.map((e) => (e.kind === 'refund' ? -e.amount : e.amount)),
    );
    if (!equal(ledgerNet, result.netAmount))
      result.issues.push('Financial events do not fully reconcile with net order amount');
  }
  result.events.sort((a, b) => a.key.localeCompare(b.key));
  result.issues = unique(result.issues);
  return result;
}
