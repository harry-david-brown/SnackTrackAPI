import type { SourceObservation } from './ReceiptGroupReconciler';
import {
  activeReceiptReviews,
  receiptReviewFingerprint,
  type ReceiptReview,
} from './ReceiptReviewDecisions';
import {
  currentSourceInterpretations,
  conflictingSourceDocuments,
} from './ReceiptSourceInterpretations';
import { providerId } from './ReceiptObservationMatching';

/** Review constrains associations only. It never edits source facts or resolves money. */
export function reviewedAssociations(
  initial: readonly (readonly SourceObservation[])[],
  history: readonly ReceiptReview[],
) {
  const sources = initial.flatMap((group) => [...group]);
  const indexById = new Map(
    initial.flatMap((group, i) => group.map((source) => [source.id, i] as const)),
  );
  const reviews = activeReceiptReviews(history);
  const selected = new Map(
    reviews.map((review) => [
      review.id,
      [
        ...new Set(
          review.observationIds
            .map((id) => indexById.get(id))
            .filter((i): i is number => i !== undefined),
        ),
      ],
    ]),
  );
  const parent = initial.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i]));
  const blocked = new Set<number>();
  const invalid = new Set<string>();
  const reject = (review: ReceiptReview) => {
    invalid.add(review.id);
    for (const i of selected.get(review.id) ?? []) blocked.add(i);
  };
  const explicitlyLinked = (a: readonly SourceObservation[], b: readonly SourceObservation[]) => {
    const left = currentSourceInterpretations(a),
      right = currentSourceInterpretations(b);
    const references = (source: SourceObservation, aliases: readonly SourceObservation[]) => {
      const reference = source.receipt.resolution?.orderEvidence?.revisionOf;
      return Boolean(
        reference &&
        aliases.some(
          (alias) =>
            reference === alias.id || reference === alias.receipt.resolution?.sourceMessageId,
        ),
      );
    };
    return left.some((x) =>
      right.some(
        (y) =>
          x.receipt.userId === y.receipt.userId &&
          x.receipt.receiptType === y.receipt.receiptType &&
          ((providerId(x.receipt) && providerId(x.receipt) === providerId(y.receipt)) ||
            references(x, b) ||
            references(y, a)),
      ),
    );
  };
  for (const review of reviews) {
    const indices = selected.get(review.id) ?? [];
    if (
      review.observationIds.some((id) => !indexById.has(id)) ||
      indices.some((i) =>
        initial[i].some(
          (source) =>
            source.receipt.userId !== review.userId || source.associationEnabled === false,
        ),
      ) ||
      review.evidence?.fingerprint !== receiptReviewFingerprint(review.observationIds, sources)
    ) {
      reject(review);
      continue;
    }
    if (review.decision === 'merge') for (const i of indices) parent[root(i)] = root(indices[0]);
    if (
      review.decision === 'keep_separate' &&
      (indices.length !== review.observationIds.length ||
        indices.some((i, position) =>
          indices.slice(position + 1).some((j) => explicitlyLinked(initial[i], initial[j])),
        ))
    )
      reject(review);
  }
  const components = new Map<number, number[]>();
  initial.forEach((_, i) => components.set(root(i), [...(components.get(root(i)) ?? []), i]));
  const compatible = (indices: readonly number[]) => {
    const current = currentSourceInterpretations(indices.flatMap((i) => [...initial[i]]));
    const scopes = new Set(
      current.map((source) => `${source.receipt.userId}:${source.receipt.receiptType}`),
    );
    const ids = new Set(current.map((source) => providerId(source.receipt)).filter(Boolean));
    const currencies = new Set(
      current
        .map((source) => source.receipt.monetaryDetails?.currencyCode)
        .filter((currency) => currency && currency !== 'UNKNOWN'),
    );
    return (
      scopes.size === 1 &&
      ids.size <= 1 &&
      currencies.size <= 1 &&
      !conflictingSourceDocuments(current).size
    );
  };
  for (const review of reviews) {
    const indices = selected.get(review.id) ?? [];
    if (
      review.decision === 'merge' &&
      indices.some((i) => !compatible(components.get(root(i)) ?? []))
    )
      reject(review);
    if (review.decision === 'keep_separate' && new Set(indices.map(root)).size !== indices.length)
      reject(review);
  }
  // A conflicting chain cannot leave half of a manual merge applied. Propagate only
  // through its selected evidence, not through unrelated restaurant/day candidates.
  let changed = true;
  while (changed) {
    const size = blocked.size;
    for (const review of reviews)
      if ((selected.get(review.id) ?? []).some((i) => blocked.has(i))) reject(review);
    changed = blocked.size !== size;
  }
  const active = reviews.filter((review) => !invalid.has(review.id));
  const positive = new Set(
    active
      .filter((review) => review.decision === 'merge')
      .flatMap((review) => (selected.get(review.id) ?? []).map(root)),
  );
  const indicesOf = (group: readonly SourceObservation[]) => [
    ...new Set(
      group.map((source) => indexById.get(source.id)).filter((i): i is number => i !== undefined),
    ),
  ];
  const reviewedRoots = (group: readonly SourceObservation[]) =>
    new Set(
      indicesOf(group)
        .map(root)
        .filter((i) => positive.has(i)),
    );
  const canAssociate = (a: readonly SourceObservation[], b: readonly SourceObservation[]) => {
    // Ordinary imports without reviewed decisions retain the inexpensive family check.
    if (!active.length && !blocked.size) return true;
    const ai = indicesOf(a),
      bi = indicesOf(b);
    if ([...ai, ...bi].some((i) => blocked.has(i))) return false;
    const manualComponents = new Set([...reviewedRoots(a), ...reviewedRoots(b)]);
    // An inferred revision must not bridge two independently reviewed purchases.
    if (manualComponents.size > 1) return false;
    // A new email revision must also agree with the export in its reviewed order,
    // not merely with the email half (which often has no order ID or currency).
    if (
      manualComponents.size &&
      !compatible([
        ...new Set([
          ...ai,
          ...bi,
          ...[...manualComponents].flatMap((component) => components.get(component) ?? []),
        ]),
      ])
    )
      return false;
    return active
      .filter((review) => review.decision === 'keep_separate')
      .every((review) => {
        const separated = new Set((selected.get(review.id) ?? []).map(root));
        const left = ai.map(root).filter((i) => separated.has(i));
        const right = bi.map(root).filter((i) => separated.has(i));
        return left.every((i) => right.every((j) => i === j));
      });
  };
  return {
    invalidReviewIds: [...invalid].sort(),
    canAssociate,
    isBlocked: (group: readonly SourceObservation[]) =>
      indicesOf(group).some((i) => blocked.has(i)),
    reviewIds: (group: readonly SourceObservation[]) => {
      const indices = new Set(indicesOf(group));
      return reviews
        .filter((review) => (selected.get(review.id) ?? []).some((i) => indices.has(i)))
        .map((review) => review.id)
        .sort();
    },
    /** Collapse selected same-source units before inferring receipt revision families. */
    sameSourceGroups: () => {
      const result = new Map<string, SourceObservation[]>();
      initial.forEach((group, i) => {
        const key =
          positive.has(root(i)) && !blocked.has(i)
            ? `review:${root(i)}:${group[0].receipt.dataSource}`
            : `unit:${i}`;
        result.set(key, [...(result.get(key) ?? []), ...group]);
      });
      return [...result.values()];
    },
    /** Leave candidate slots intact after this join; never match by elimination. */
    mergedIndices: (groups: readonly (readonly SourceObservation[])[]) =>
      [...positive]
        .map((component) =>
          groups.flatMap((group, i) =>
            !indicesOf(group).some((j) => blocked.has(j)) && reviewedRoots(group).has(component)
              ? [i]
              : [],
          ),
        )
        .filter((indices) => indices.length > 0),
  };
}
