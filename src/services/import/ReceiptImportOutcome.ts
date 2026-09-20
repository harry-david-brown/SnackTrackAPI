import type { Receipt, ReceiptCurrencyCode } from '../../models/Receipt';
import { moneySum } from '../../models/ReceiptResolution';
import { orderMetricCurrency, orderMetricEligibility } from '../analytics/shared/orderMetrics';
import { evidenceFingerprint } from '../receipt/ReceiptEvidenceFingerprint';

/** Minimal, content-free baseline; no email body, merchant, item or payment details. */
export interface ImportReceiptBaseline {
  id: string;
  observationIds: string[];
  fingerprint: string;
  established: boolean;
  canceled: boolean;
  adjustmentFingerprint: string | null;
}

export interface ReceiptImportOutcomeState {
  version: 1;
  policyVersion: 3;
  baseline: ImportReceiptBaseline[];
  importedObservationIds: string[];
  affectedObservationIds: string[];
  affectedReceiptIds: string[];
}

export type ReceiptImportScope = 'gmail' | 'microsoft' | 'export';
export interface ReceiptImportAccounting {
  jobId: string;
  scope: ReceiptImportScope;
}

/** A tracking operation can check both mailboxes. Their phase outcomes are not additive. */
export interface ReceiptImportOutcomeLedger extends ReceiptImportOutcomeState {
  scopes: Partial<Record<ReceiptImportScope, ReceiptImportOutcomeState>>;
}

export interface ReceiptImportOutcome {
  policyVersion: 3;
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
  unresolvedOrders: number;
  unlinkedAdjustments: number;
  /** Distinct established orders gaining changed non-charge financial evidence. */
  adjustedOrders: number;
  cancellationsRecovered: number;
  ordersProcessed: number;
  sourceDocuments: number;
  /** Final value of the orders checked, not incremental spend caused by the import. */
  currencies: {
    currencyCode: ReceiptCurrencyCode;
    netAmount: number;
    pricedOrders: number;
    unpricedOrders: number;
    possibleAdditionalAmount: number;
    unpricedPossibleOrders: number;
  }[];
}

/** Validate stored/public outcomes independently of the internal membership ledger. */
export function decodeReceiptImportOutcome(value: unknown): ReceiptImportOutcome {
  const invalid = (): never => {
    throw new Error('Invalid receipt import outcome');
  };
  const object = (candidate: unknown): Record<string, unknown> =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : invalid();
  const count = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : invalid();
  const amount = (candidate: unknown): number =>
    typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= 0 &&
    Math.abs(candidate * 100 - Math.round(candidate * 100)) < 0.00001
      ? candidate
      : invalid();
  const raw = object(value);
  if (raw.policyVersion !== 3 || !Array.isArray(raw.currencies)) return invalid();
  const currencies = raw.currencies.map((candidate) => {
    const currency = object(candidate);
    const currencyCode = (['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'] as const).find(
      (code) => code === currency.currencyCode,
    );
    if (!currencyCode) return invalid();
    return {
      currencyCode,
      netAmount: amount(currency.netAmount),
      pricedOrders: count(currency.pricedOrders),
      unpricedOrders: count(currency.unpricedOrders),
      possibleAdditionalAmount: amount(currency.possibleAdditionalAmount),
      unpricedPossibleOrders: count(currency.unpricedPossibleOrders),
    };
  });
  const result: ReceiptImportOutcome = {
    policyVersion: 3,
    newOrders: count(raw.newOrders),
    updatedOrders: count(raw.updatedOrders),
    unchangedOrders: count(raw.unchangedOrders),
    unresolvedOrders: count(raw.unresolvedOrders),
    unlinkedAdjustments: count(raw.unlinkedAdjustments),
    adjustedOrders: count(raw.adjustedOrders),
    cancellationsRecovered: count(raw.cancellationsRecovered),
    ordersProcessed: count(raw.ordersProcessed),
    sourceDocuments: count(raw.sourceDocuments),
    currencies,
  };
  if (
    new Set(currencies.map((currency) => currency.currencyCode)).size !== currencies.length ||
    result.ordersProcessed !== result.newOrders + result.updatedOrders + result.unchangedOrders ||
    result.adjustedOrders > result.newOrders + result.updatedOrders ||
    result.cancellationsRecovered > result.newOrders + result.updatedOrders ||
    currencies.reduce(
      (sum, currency) => sum + currency.pricedOrders + currency.unpricedOrders,
      0,
    ) !== result.ordersProcessed ||
    currencies.some((currency) => currency.pricedOrders === 0 && currency.netAmount !== 0) ||
    currencies.reduce((sum, currency) => sum + currency.unpricedPossibleOrders, 0) >
      result.unresolvedOrders
  )
    return invalid();
  return result;
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();
const members = (receipt: Receipt) =>
  unique(receipt.resolution?.reconciliation?.observationIds ?? []);

export function importReceiptBaseline(receipt: Receipt): ImportReceiptBaseline {
  if (!receipt.id) throw new Error('Import accounting requires canonical receipt identity');
  const { id, ...content } = receipt;
  const eligibility = orderMetricEligibility(receipt);
  const adjustments =
    receipt.resolution?.orderOutcome?.events.filter((event) => event.kind !== 'charge') ?? [];
  return {
    id,
    observationIds: members(receipt),
    fingerprint: evidenceFingerprint(content),
    established: eligibility.establishedAttempt,
    canceled: eligibility.fulfillment === 'canceled',
    adjustmentFingerprint: adjustments.length ? evidenceFingerprint(adjustments) : null,
  };
}

export function startReceiptImportOutcome(receipts: readonly Receipt[]): ReceiptImportOutcomeState {
  return {
    version: 1,
    policyVersion: 3,
    baseline: receipts.map(importReceiptBaseline).sort((a, b) => a.id.localeCompare(b.id)),
    importedObservationIds: [],
    affectedObservationIds: [],
    affectedReceiptIds: [],
  };
}

/** Called with each committed page's complete before/after projections, including indirect splits. */
export function recordReceiptImportPage(
  state: ReceiptImportOutcomeState,
  before: readonly Receipt[],
  after: readonly Receipt[],
  incomingIds: readonly string[],
): ReceiptImportOutcomeState {
  const previous = before.map(importReceiptBaseline);
  const current = after.map(importReceiptBaseline);
  const previousById = new Map(previous.map((receipt) => [receipt.id, receipt]));
  const currentById = new Map(current.map((receipt) => [receipt.id, receipt]));
  const changed = [
    ...previous.filter(
      (receipt) => receipt.fingerprint !== currentById.get(receipt.id)?.fingerprint,
    ),
    ...current.filter(
      (receipt) => receipt.fingerprint !== previousById.get(receipt.id)?.fingerprint,
    ),
  ];
  return {
    ...state,
    importedObservationIds: unique([...state.importedObservationIds, ...incomingIds]),
    affectedObservationIds: unique([
      ...state.affectedObservationIds,
      ...incomingIds,
      ...changed.flatMap((receipt) => receipt.observationIds),
    ]),
    affectedReceiptIds: unique([
      ...state.affectedReceiptIds,
      ...changed.map((receipt) => receipt.id),
    ]),
  };
}

/** Bookkeeping only: this never establishes or changes an order association. */
function baselineOwners(
  baseline: readonly ImportReceiptBaseline[],
  final: readonly ImportReceiptBaseline[],
): Map<string, ImportReceiptBaseline> {
  const old = baseline
    .filter((receipt) => receipt.established)
    .sort((a, b) => a.id.localeCompare(b.id));
  const oldById = new Map(old.map((receipt) => [receipt.id, receipt]));
  const oldByObservation = new Map<string, ImportReceiptBaseline[]>();
  for (const receipt of old)
    for (const id of receipt.observationIds)
      oldByObservation.set(id, [...(oldByObservation.get(id) ?? []), receipt]);
  const candidates = new Map(
    final.map((receipt) => {
      const sameId = oldById.get(receipt.id);
      const possible = [
        ...new Map(
          [
            ...(sameId ? [sameId] : []),
            ...receipt.observationIds.flatMap((id) => oldByObservation.get(id) ?? []),
          ].map((candidate) => [candidate.id, candidate]),
        ).values(),
      ];
      return [
        receipt.id,
        possible.sort(
          (a, b) =>
            Number(b.id === receipt.id) - Number(a.id === receipt.id) || a.id.localeCompare(b.id),
        ),
      ];
    }),
  );
  const oldToFinal = new Map<string, { owner: ImportReceiptBaseline; finalId: string }>();
  const finalToOld = new Map<string, string>();
  const assign = (root: string): void => {
    const queue = [root];
    const seenFinal = new Set(queue);
    const path = new Map<string, { owner: ImportReceiptBaseline; finalId: string }>();
    for (let offset = 0; offset < queue.length; offset++) {
      const id = queue[offset];
      for (const previous of candidates.get(id) ?? []) {
        if (path.has(previous.id)) continue;
        path.set(previous.id, { owner: previous, finalId: id });
        const assigned = oldToFinal.get(previous.id);
        if (assigned) {
          if (!seenFinal.has(assigned.finalId)) {
            seenFinal.add(assigned.finalId);
            queue.push(assigned.finalId);
          }
          continue;
        }
        let next: string | undefined = previous.id;
        while (next) {
          const edge = path.get(next);
          if (!edge) throw new Error('Invalid import lineage accounting path');
          const displaced = finalToOld.get(edge.finalId);
          oldToFinal.set(next, edge);
          finalToOld.set(edge.finalId, next);
          next = displaced;
        }
        return;
      }
    }
  };
  // Maximum-cardinality lineage accounting avoids crediting a merged/split purchase twice.
  for (const receipt of [...final].sort((a, b) => a.id.localeCompare(b.id))) assign(receipt.id);
  return new Map([...oldToFinal.values()].map(({ owner, finalId }) => [finalId, owner]));
}

/** Job storage is an untrusted boundary, including checkpoints written by older builds. */
export function decodeReceiptImportOutcomeState(value: unknown): ReceiptImportOutcomeState {
  const invalid = (): never => {
    throw new Error('Invalid receipt import outcome state');
  };
  const object = (candidate: unknown): Record<string, unknown> =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : invalid();
  const identity = (candidate: unknown): string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128
      ? candidate
      : invalid();
  const identities = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate)) return invalid();
    const ids = candidate.map(identity);
    if (new Set(ids).size !== ids.length) return invalid();
    return ids.sort();
  };
  const fingerprint = (candidate: unknown): string =>
    typeof candidate === 'string' && /^[a-f\d]{64}$/.test(candidate) ? candidate : invalid();
  const raw = object(value);
  if (raw.version !== 1 || raw.policyVersion !== 3 || !Array.isArray(raw.baseline))
    return invalid();
  const baseline = raw.baseline
    .map((candidate) => {
      const receipt = object(candidate);
      if (typeof receipt.established !== 'boolean' || typeof receipt.canceled !== 'boolean')
        return invalid();
      return {
        id: identity(receipt.id),
        observationIds: identities(receipt.observationIds),
        fingerprint: fingerprint(receipt.fingerprint),
        established: receipt.established,
        canceled: receipt.canceled,
        adjustmentFingerprint:
          receipt.adjustmentFingerprint === null
            ? null
            : fingerprint(receipt.adjustmentFingerprint),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(baseline.map((receipt) => receipt.id)).size !== baseline.length) return invalid();
  return {
    version: 1,
    policyVersion: 3,
    baseline,
    importedObservationIds: identities(raw.importedObservationIds),
    affectedObservationIds: identities(raw.affectedObservationIds),
    affectedReceiptIds: identities(raw.affectedReceiptIds),
  };
}

export function decodeReceiptImportOutcomeLedger(value: unknown): ReceiptImportOutcomeLedger {
  const state = decodeReceiptImportOutcomeState(value);
  const raw = value as Record<string, unknown>; // The state decoder has validated this object.
  if (!raw.scopes || typeof raw.scopes !== 'object' || Array.isArray(raw.scopes))
    throw new Error('Invalid receipt import accounting scopes');
  const scopes: ReceiptImportOutcomeLedger['scopes'] = {};
  for (const [scope, ledger] of Object.entries(raw.scopes)) {
    if (scope !== 'gmail' && scope !== 'microsoft' && scope !== 'export')
      throw new Error('Invalid receipt import accounting scope');
    scopes[scope] = decodeReceiptImportOutcomeState(ledger);
  }
  return { ...state, scopes };
}

/** Compatibility fields have one owner; mixed or unknown pricing cannot become a scalar total. */
export function receiptImportOutcomeFields(outcome: ReceiptImportOutcome) {
  const priced = outcome.currencies.filter(
    (currency) => currency.pricedOrders + currency.unpricedOrders > 0,
  );
  const currency =
    priced.length === 1 && priced[0].currencyCode !== 'UNKNOWN' && priced[0].unpricedOrders === 0
      ? priced[0]
      : undefined;
  return {
    receiptOutcome: outcome,
    newOrders: outcome.newOrders,
    updatedOrders: outcome.updatedOrders,
    unchangedOrders: outcome.unchangedOrders,
    unresolvedOrders: outcome.unresolvedOrders,
    totalReceiptsImported: outcome.ordersProcessed,
    importedCount: outcome.ordersProcessed,
    totalAmount: outcome.ordersProcessed === 0 ? 0 : (currency?.netAmount ?? null),
    currencyCode: currency?.currencyCode ?? null,
  };
}

export function resolveReceiptImportOutcome(
  state: ReceiptImportOutcomeState,
  receipts: readonly Receipt[],
): ReceiptImportOutcome {
  const affectedIds = new Set(state.affectedObservationIds);
  const affectedReceipts = new Set(state.affectedReceiptIds);
  const affected = receipts.filter(
    (receipt) =>
      Boolean(receipt.id && affectedReceipts.has(receipt.id)) ||
      members(receipt).some((id) => affectedIds.has(id)),
  );
  // Include untouched final orders in lineage allocation so their baseline cannot be spent twice.
  const owners = baselineOwners(
    state.baseline,
    receipts
      .filter((receipt) => orderMetricEligibility(receipt).establishedAttempt)
      .map(importReceiptBaseline),
  );
  const result: ReceiptImportOutcome = {
    policyVersion: 3,
    newOrders: 0,
    updatedOrders: 0,
    unchangedOrders: 0,
    unresolvedOrders: 0,
    unlinkedAdjustments: 0,
    adjustedOrders: 0,
    cancellationsRecovered: 0,
    ordersProcessed: 0,
    sourceDocuments: state.importedObservationIds.length,
    currencies: [],
  };
  const currencies = new Map<ReceiptCurrencyCode, ReceiptImportOutcome['currencies'][number]>();
  for (const receipt of affected) {
    const eligible = orderMetricEligibility(receipt);
    if (eligible.unlinkedAdjustment) {
      result.unlinkedAdjustments++;
      continue;
    }
    const code = orderMetricCurrency(receipt);
    const currency = currencies.get(code) ?? {
      currencyCode: code,
      netAmount: 0,
      pricedOrders: 0,
      unpricedOrders: 0,
      possibleAdditionalAmount: 0,
      unpricedPossibleOrders: 0,
    };
    currencies.set(code, currency);
    if (eligible.possibleAdditionalOrder) {
      result.unresolvedOrders++;
      if (eligible.netAmount === null) currency.unpricedPossibleOrders++;
      else
        currency.possibleAdditionalAmount = moneySum([
          currency.possibleAdditionalAmount,
          eligible.netAmount,
        ]);
      continue;
    }
    const final = importReceiptBaseline(receipt);
    const previous = owners.get(final.id);
    result.ordersProcessed++;
    if (!previous) result.newOrders++;
    else if (previous.fingerprint !== final.fingerprint) result.updatedOrders++;
    else result.unchangedOrders++;
    if (
      final.adjustmentFingerprint &&
      final.adjustmentFingerprint !== previous?.adjustmentFingerprint
    )
      result.adjustedOrders++;
    if (final.canceled && !previous?.canceled) result.cancellationsRecovered++;
    if (eligible.netAmount === null) currency.unpricedOrders++;
    else {
      currency.pricedOrders++;
      currency.netAmount = moneySum([currency.netAmount, eligible.netAmount]);
    }
  }
  result.currencies = [...currencies.values()].sort((a, b) =>
    a.currencyCode.localeCompare(b.currencyCode),
  );
  return result;
}
