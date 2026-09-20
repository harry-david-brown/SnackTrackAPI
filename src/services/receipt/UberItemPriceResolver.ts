import type { ItemPriceResolution } from '../../models/ReceiptResolution';
import type { ExportItemRow } from './OrderReconstruction';

const DAY_MS = 86_400_000;
const REFERENCE_WINDOW_MS = 365 * DAY_MS;
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[®™©]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const amount = (value: string): number => Number(value || 0);
const quantity = (value: string): number => Number(value || 1);
const time = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const matches = (candidate: number, reference: number): boolean =>
  Math.abs(candidate - reference) <= Math.max(0.25, reference * 0.15);

export interface UberPriceDocument {
  merchant: string;
  currency: string;
  orderDate: string;
  rows: readonly ExportItemRow[];
}

interface Observation {
  key: string;
  currency: string;
  date: number;
  row: ExportItemRow;
}

type Basis = 'unit' | 'line';
interface Anchor extends Observation { basis: Basis }

const observationKey = (document: UberPriceDocument, row: ExportItemRow): string =>
  JSON.stringify([normalize(document.merchant), document.currency.trim().toUpperCase(), normalize(row.Item_Name)]);

const resolved = (basis: Basis, row: ExportItemRow, status: 'unit_inferred' | 'line_inferred', reasons: string[]): ItemPriceResolution => {
  const recordedAmount = amount(row.Item_Price);
  const count = quantity(row.Item_quantity);
  return basis === 'unit'
    ? { status, recordedAmount, unitAmount: recordedAmount, lineAmount: Math.round(recordedAmount * count * 100) / 100, reasons }
    : { status, recordedAmount, unitAmount: recordedAmount / count, lineAmount: recordedAmount, reasons };
};

/** Builds an import-scoped resolver. Dates only locate comparable evidence; no calendar cutoff decides the basis. */
export function createUberItemPriceResolver(documents: readonly UberPriceDocument[]) {
  const observations: Observation[] = documents.flatMap((document) =>
    document.rows.map((row) => ({
      key: observationKey(document, row),
      currency: document.currency.trim().toUpperCase(),
      date: time(document.orderDate),
      row,
    })),
  );
  const singles = observations.filter((entry) => quantity(entry.row.Item_quantity) === 1);
  const directBasis = (entry: Observation): Basis | undefined => {
    const recorded = amount(entry.row.Item_Price);
    const count = quantity(entry.row.Item_quantity);
    if (count === 1) return 'unit';
    const references = singles.filter((candidate) => candidate.key === entry.key && Math.abs(candidate.date - entry.date) <= REFERENCE_WINDOW_MS);
    if (!references.length) return undefined;
    const reference = median(references.map((candidate) => amount(candidate.row.Item_Price)));
    const unitMatches = matches(recorded, reference);
    const lineMatches = matches(recorded / count, reference);
    return unitMatches === lineMatches ? undefined : unitMatches ? 'unit' : 'line';
  };
  const anchors: Anchor[] = observations
    .filter((entry) => quantity(entry.row.Item_quantity) > 1)
    .flatMap((entry) => {
      const basis = directBasis(entry);
      return basis ? [{ ...entry, basis }] : [];
    });

  return (document: Omit<UberPriceDocument, 'rows'>, row: ExportItemRow): ItemPriceResolution => {
    const recordedAmount = amount(row.Item_Price);
    const count = quantity(row.Item_quantity);
    if (count === 1)
      return { status: 'unit_reconciled', recordedAmount, unitAmount: recordedAmount, lineAmount: recordedAmount, reasons: ['quantity_one'] };
    const entry = {
      key: observationKey({ ...document, rows: [] }, row),
      currency: document.currency.trim().toUpperCase(),
      date: time(document.orderDate),
      row,
    };
    const direct = directBasis(entry);
    if (direct) return resolved(direct, row, direct === 'unit' ? 'unit_inferred' : 'line_inferred', ['same_item_quantity_one_reference']);
    const nearby = anchors.filter(
      (anchor) =>
        anchor.currency === entry.currency &&
        Math.abs(anchor.date - entry.date) <= REFERENCE_WINDOW_MS,
    );
    const bySubject = new Map<string, Set<Basis>>();
    for (const anchor of nearby) {
      const bases = bySubject.get(anchor.key) ?? new Set<Basis>();
      bases.add(anchor.basis);
      bySubject.set(anchor.key, bases);
    }
    const conflicts = [...bySubject.values()].some((bases) => bases.size !== 1);
    const votes = [...bySubject.values()].flatMap((bases) => [...bases]);
    if (!conflicts && votes.length >= 3 && votes.every((vote) => vote === votes[0]))
      return resolved(votes[0], row, votes[0] === 'unit' ? 'unit_inferred' : 'line_inferred', ['unanimous_import_cohort']);
    return {
      status: 'ambiguous',
      recordedAmount,
      reasons: conflicts || votes.length ? ['conflicting_or_insufficient_cohort'] : ['no_price_basis_evidence'],
    };
  };
}
