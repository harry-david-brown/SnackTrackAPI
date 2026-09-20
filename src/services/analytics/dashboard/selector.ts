import { DashboardInsight, DashboardInsightCategory, InsightCandidate } from './types';
import { applyDailyCopyVariant } from './copy';
import { stableHash } from './hash';

const CATEGORIES: DashboardInsightCategory[] = ['progress', 'favorites', 'habits', 'extremes'];

function eligibleRealCandidates(candidates: InsightCandidate[]) {
  return candidates.filter((candidate) => !candidate.locked && candidate.score >= 50);
}

function ranked(candidates: InsightCandidate[], seed: string) {
  return [...candidates].sort((a, b) => {
    // A bounded daily lift lets similarly strong observations rotate without
    // allowing a weak novelty to outrank a genuinely useful fact.
    const aDailyScore = a.score + (stableHash(`${seed}:rank:${a.insight.id}`) % 15);
    const bDailyScore = b.score + (stableHash(`${seed}:rank:${b.insight.id}`) % 15);
    const scoreDifference = bDailyScore - aDailyScore;
    if (scoreDifference) return scoreDifference;
    const jitterDifference =
      stableHash(`${seed}:${a.insight.id}`) - stableHash(`${seed}:${b.insight.id}`);
    return jitterDifference || a.insight.id.localeCompare(b.insight.id);
  });
}

function related(candidate: InsightCandidate, selected: InsightCandidate[]) {
  return selected.some(
    (existing) =>
      Boolean(candidate.subjectGroup && existing.subjectGroup === candidate.subjectGroup) ||
      existing.family === candidate.family ||
      existing.relatedFamilies?.includes(candidate.family) ||
      candidate.relatedFamilies?.includes(existing.family) ||
      Boolean(
        existing.relatedFamilies?.some((family) => candidate.relatedFamilies?.includes(family)),
      ),
  );
}

function selectForSeed(
  candidates: InsightCandidate[],
  seed: string,
  maxCards: number,
): InsightCandidate[] {
  const real = ranked(eligibleRealCandidates(candidates), seed);
  const locked = ranked(
    candidates.filter((candidate) => candidate.locked),
    `${seed}:locked`,
  )[0];
  const realLimit = locked ? Math.max(0, maxCards - 1) : maxCards;
  const selected: InsightCandidate[] = [];

  for (const category of CATEGORIES) {
    const candidate = real.find(
      (item) =>
        item.insight.category === category && !selected.includes(item) && !related(item, selected),
    );
    if (candidate && selected.length < realLimit) selected.push(candidate);
  }
  for (const candidate of real) {
    if (selected.length >= realLimit) break;
    if (!selected.includes(candidate) && !related(candidate, selected)) selected.push(candidate);
  }
  for (const candidate of real) {
    if (selected.length >= realLimit) break;
    if (
      !selected.includes(candidate) &&
      !selected.some(
        (existing) => candidate.subjectGroup && existing.subjectGroup === candidate.subjectGroup,
      )
    ) {
      selected.push(candidate);
    }
  }

  // Ordering is daily, deterministic, and weighted: timely/high-signal cards
  // stay near the front while the hash changes which peer wins a tie.
  selected.sort((a, b) => {
    const aPriority =
      a.score + (a.timely ? 6 : 0) + (stableHash(`${seed}:front:${a.insight.id}`) % 11);
    const bPriority =
      b.score + (b.timely ? 6 : 0) + (stableHash(`${seed}:front:${b.insight.id}`) % 11);
    return (
      bPriority - aPriority ||
      stableHash(`${seed}:order:${a.insight.id}`) - stableHash(`${seed}:order:${b.insight.id}`) ||
      a.insight.id.localeCompare(b.insight.id)
    );
  });

  if (locked && selected.length < maxCards) selected.push(locked);
  return selected;
}

function cooldownCycleLength(candidateCount: number, maxCards: number) {
  if (candidateCount >= maxCards * 3) return 3;
  if (candidateCount >= maxCards * 2) return 2;
  return 1;
}

/**
 * Give each eligible insight one stable day group. With at least three full
 * editions, a group only returns every third day; with two, it returns every
 * other day. Assignment balances both total cards and editorial categories so
 * the cooldown does not trade variety for seven cards from one category.
 */
function buildCooldownPool(
  candidates: InsightCandidate[],
  userId: string,
  localDate: string,
  metricVersion: string,
  maxCards: number,
) {
  const real = eligibleRealCandidates(candidates);
  const cycleLength = cooldownCycleLength(real.length, maxCards);
  if (cycleLength === 1) return { candidates, cycleLength };

  const groups = Array.from({ length: cycleLength }, () => [] as InsightCandidate[]);
  const categoryCounts = groups.map(() => new Map<DashboardInsightCategory, number>());
  for (const category of CATEGORIES) {
    const categoryCandidates = real
      .filter((candidate) => candidate.insight.category === category)
      .sort(
        (a, b) =>
          stableHash(`${userId}:${metricVersion}:cooldown-order:${a.insight.id}`) -
            stableHash(`${userId}:${metricVersion}:cooldown-order:${b.insight.id}`) ||
          a.insight.id.localeCompare(b.insight.id),
      );
    for (const candidate of categoryCandidates) {
      const target = groups
        .map((group, index) => ({
          group,
          index,
          categoryCount: categoryCounts[index].get(category) ?? 0,
          siblingCount: candidate.subjectGroup
            ? group.filter((existing) => existing.subjectGroup === candidate.subjectGroup).length
            : 0,
          tieBreaker: stableHash(
            `${userId}:${metricVersion}:cooldown-group:${candidate.insight.id}:${index}`,
          ),
        }))
        .sort(
          (a, b) =>
            a.siblingCount - b.siblingCount ||
            a.categoryCount - b.categoryCount ||
            a.group.length - b.group.length ||
            a.tieBreaker - b.tieBreaker ||
            a.index - b.index,
        )[0];
      target.group.push(candidate);
      categoryCounts[target.index].set(category, target.categoryCount + 1);
    }
  }

  const dayOrdinal = Math.floor(Date.parse(`${localDate}T00:00:00.000Z`) / 86_400_000);
  const userOffset = stableHash(`${userId}:${metricVersion}:cooldown-offset`) % cycleLength;
  const activeGroup = groups[(dayOrdinal + userOffset) % cycleLength];
  // Locked previews are a durable Gmail-only product requirement rather than
  // rotating real insights, so keep them outside the cooldown partition.
  return {
    candidates: [...activeGroup, ...candidates.filter((candidate) => candidate.locked)],
    cycleLength,
  };
}

export function selectDailyInsights(
  candidates: InsightCandidate[],
  userId: string,
  localDate: string,
  metricVersion: string,
  maxCards = 7,
): DashboardInsight[] {
  const seed = `${userId}:${localDate}:${metricVersion}`;
  const cooldown = buildCooldownPool(candidates, userId, localDate, metricVersion, maxCards);
  const selected = selectForSeed(cooldown.candidates, seed, maxCards);
  if (cooldown.cycleLength > 1) {
    return selected.slice(0, maxCards).map((candidate) => applyDailyCopyVariant(candidate, seed));
  }
  const openerPool = [...candidates]
    // Use durable lifetime facts for the opener cycle. Recency candidates can
    // enter or leave eligibility overnight, which would make a modulo-based
    // cycle repeat despite having alternatives.
    .filter((candidate) => !candidate.locked && !candidate.timely && candidate.score >= 72)
    .sort((a, b) => b.score - a.score || a.insight.id.localeCompare(b.insight.id))
    .slice(0, 7);
  if (openerPool.length > 1 && selected.length) {
    const dayOrdinal = Math.floor(Date.parse(`${localDate}T00:00:00.000Z`) / 86_400_000);
    const userOffset = stableHash(`${userId}:${metricVersion}:opener`) % openerPool.length;
    const desiredOpener = openerPool[(dayOrdinal + userOffset) % openerPool.length];
    let openerIndex = selected.findIndex(
      (candidate) => candidate.insight.id === desiredOpener.insight.id,
    );
    if (openerIndex < 0) {
      const siblingIndex = selected.findIndex(
        (candidate) => desiredOpener.subjectGroup && candidate.subjectGroup === desiredOpener.subjectGroup,
      );
      const relatedIndex = selected.findIndex(
        (candidate) => !candidate.locked && related(desiredOpener, [candidate]),
      );
      const replaceIndex =
        siblingIndex >= 0
          ? siblingIndex
          : relatedIndex >= 0
          ? relatedIndex
          : selected
              .map((candidate, index) => ({ candidate, index }))
              .filter(({ candidate }) => !candidate.locked)
              .sort((a, b) => a.candidate.score - b.candidate.score || b.index - a.index)[0]?.index;
      if (replaceIndex !== undefined) {
        selected[replaceIndex] = desiredOpener;
        openerIndex = replaceIndex;
      }
    }
    if (openerIndex > 0)
      [selected[0], selected[openerIndex]] = [selected[openerIndex], selected[0]];
  }
  return selected.slice(0, maxCards).map((candidate) => applyDailyCopyVariant(candidate, seed));
}
