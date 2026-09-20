import type { OrderFinancialEvent, PaymentEvidence } from '../../models/OrderEvidence';

const minor = (amount: number) => Math.round(amount * 100);
export const paymentTimestampKey = (payment: PaymentEvidence): string | null => {
  const instant = payment.timestamp?.instant;
  // UTC and explicit-offset spellings identify the same payment instant.
  return instant ? new Date(instant).toISOString() : (payment.timestamp?.raw ?? null);
};

/** Snapshot content is not event identity: conflicting copies must remain inspectable. */
export const paymentSnapshotKey = (payment: PaymentEvidence): string =>
  JSON.stringify([
    payment.kind,
    payment.reference ?? null,
    minor(payment.amount),
    payment.tender,
    payment.currencyCode ?? null,
    payment.cardLastFour ?? null,
    payment.timestamp?.role ?? null,
    paymentTimestampKey(payment),
  ]);

const compatibleCopy = (a: PaymentEvidence, b: PaymentEvidence): boolean =>
  a.kind === b.kind &&
  minor(a.amount) === minor(b.amount) &&
  (a.tender === 'unknown' || b.tender === 'unknown' || a.tender === b.tender) &&
  (!a.currencyCode ||
    !b.currencyCode ||
    a.currencyCode === 'UNKNOWN' ||
    b.currencyCode === 'UNKNOWN' ||
    a.currencyCode === b.currencyCode) &&
  (!a.cardLastFour || !b.cardLastFour || a.cardLastFour === b.cardLastFour) &&
  (!a.timestamp ||
    !b.timestamp ||
    a.timestamp.role !== b.timestamp.role ||
    paymentTimestampKey(a) === paymentTimestampKey(b));

interface PaymentSnapshot {
  ids: readonly string[];
  evidence: { payments: readonly PaymentEvidence[] };
}

/** Scoped to one associated order. References distinguish equal-value installments. */
export function resolvePaymentEvents(sources: readonly PaymentSnapshot[]): {
  events: OrderFinancialEvent[];
  conflict: boolean;
} {
  const groups = new Map<string, { payment: PaymentEvidence; ids: readonly string[] }[]>();
  for (const source of sources) {
    for (const payment of source.evidence.payments) {
      const key = payment.reference
        ? JSON.stringify(['reference', payment.kind, payment.reference])
        : paymentSnapshotKey(payment);
      groups.set(key, [...(groups.get(key) ?? []), { payment, ids: source.ids }]);
    }
  }
  let conflict = false;
  const uncertainKeys = new Set<string>();
  // A detailed copy can add the reference missing from an earlier snapshot.
  // Evaluate the original candidate set: equal-value installments cannot force a last pair.
  const referenced = [...groups].filter(([, copies]) => copies[0].payment.reference);
  const proposed = new Map<string, string>();
  for (const [key, copies] of groups) {
    if (copies[0].payment.reference) continue;
    const candidates = referenced.filter(([, candidates]) =>
      copies.every((a) => candidates.every((b) => compatibleCopy(a.payment, b.payment))),
    );
    if (candidates.length === 1) proposed.set(key, candidates[0][0]);
    else if (candidates.length > 1) {
      conflict = true;
      uncertainKeys.add(key);
    }
  }
  for (const [referenceKey] of referenced) {
    const matchingKeys = [...proposed]
      .filter(([, candidate]) => candidate === referenceKey)
      .map(([key]) => key);
    const copies = matchingKeys.flatMap((key) => groups.get(key) ?? []);
    if (!copies.every((a) => copies.every((b) => compatibleCopy(a.payment, b.payment)))) {
      conflict = true;
      matchingKeys.forEach((key) => uncertainKeys.add(key));
      continue;
    }
    for (const key of matchingKeys) {
      groups.set(referenceKey, [...(groups.get(referenceKey) ?? []), ...(groups.get(key) ?? [])]);
      groups.delete(key);
    }
  }
  const events: OrderFinancialEvent[] = [];
  for (const [key, copies] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const distinct = <T>(values: T[]) => [...new Set(values)];
    const currencies = distinct(
      copies
        .map(({ payment }) => payment.currencyCode)
        .filter((value) => value && value !== 'UNKNOWN'),
    );
    const tenders = distinct(
      copies.map(({ payment }) => payment.tender).filter((value) => value !== 'unknown'),
    );
    const cards = distinct(copies.map(({ payment }) => payment.cardLastFour).filter(Boolean));
    const inconsistent =
      distinct(copies.map(({ payment }) => minor(payment.amount))).length > 1 ||
      currencies.length > 1 ||
      tenders.length > 1 ||
      cards.length > 1;
    const observationIds = distinct(copies.flatMap(({ ids }) => [...ids])).sort();
    if (inconsistent) {
      conflict = true;
      // Preserve both interpretations without presenting them as two settled payments.
      const interpretations = new Map<string, typeof copies>();
      for (const copy of copies) {
        const snapshotKey = paymentSnapshotKey(copy.payment);
        interpretations.set(snapshotKey, [...(interpretations.get(snapshotKey) ?? []), copy]);
      }
      for (const [snapshotKey, variants] of [...interpretations].sort(([a], [b]) =>
        a.localeCompare(b),
      ))
        events.push({
          ...variants[0].payment,
          key: `${key}:${snapshotKey}`,
          confidence: 'conflicted',
          observationIds: distinct(variants.flatMap((copy) => [...copy.ids])).sort(),
        });
      continue;
    }
    const payment = [...copies].sort(
      (a, b) =>
        paymentSnapshotKey(a.payment).localeCompare(paymentSnapshotKey(b.payment)) ||
        (a.payment.timestamp?.raw ?? '').localeCompare(b.payment.timestamp?.raw ?? ''),
    )[0].payment;
    const reference = copies.find((copy) => copy.payment.reference)?.payment.reference;
    events.push({
      ...payment,
      ...(reference ? { reference } : {}),
      ...(currencies[0] ? { currencyCode: currencies[0] } : {}),
      ...(tenders[0] ? { tender: tenders[0] } : {}),
      ...(cards[0] ? { cardLastFour: cards[0] } : {}),
      key,
      confidence: uncertainKeys.has(key) ? 'conflicted' : 'confirmed',
      observationIds,
    });
  }
  return { events, conflict };
}
