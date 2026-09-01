import { DashboardInsight, InsightCandidate } from './types';
import { stableHash } from './hash';

export type InsightValueBand = 'small' | 'notable' | 'major' | 'legendary';

export function getInsightValueBand(value: number): InsightValueBand {
  const magnitude = Math.abs(value);
  if (magnitude >= 500) return 'legendary';
  if (magnitude >= 100) return 'major';
  if (magnitude >= 20) return 'notable';
  return 'small';
}

const COPY_VARIANTS: Record<string, string[]> = {
  foodflation: [
    'Your wallet clocked it.',
    'Same craving, different damage.',
    'The receipt remembered.',
  ],
  'exact-basket': [
    'Your order history found its comfort blanket.',
    'Consistency, but make it delicious.',
    'No menu browsing required.',
  ],
  'restaurant-run': [
    'A loyalty program should probably name a tier after you.',
    'Variety briefly left the group chat.',
    'You knew exactly what you wanted. Repeatedly.',
  ],
  'delivery-lifetime': [
    'That is a lot of tiny ETA refreshes.',
    'A cinematic universe of delivery windows.',
    'Time flies when somebody else is cooking.',
  ],
  'alternate-universe': [
    'A spreadsheet opened a portal to another timeline.',
    'Your receipts just tried on a tiny finance hat.',
    'Purely hypothetical; surprisingly specific.',
  ],
};

const BAND_LINES: Partial<Record<InsightValueBand, string[]>> = {
  major: ['The pattern is no longer subtle.', 'This one brought evidence.'],
  legendary: ['The spreadsheet needed a moment.', 'That has officially become lore.'],
};

export function applyDailyCopyVariant(candidate: InsightCandidate, seed: string): DashboardInsight {
  const variants = candidate.copyVariants ?? COPY_VARIANTS[candidate.family];
  const copy = candidate.copy ?? {
    eyebrow: candidate.insight.eyebrow,
    title: candidate.insight.title,
    detail: candidate.insight.detail,
  };
  if (candidate.insight.presentation === 'locked') return { ...candidate.insight, ...copy };
  const numericFact = Object.values(candidate.facts ?? {}).find(
    (value) => typeof value === 'number',
  ) as number | undefined;
  const band = numericFact === undefined ? 'small' : getInsightValueBand(numericFact);
  // Named families get their own voice on every edition. Value-band copy is a
  // fallback for candidates without more specific material.
  const options = variants?.length ? variants : (BAND_LINES[band] ?? []);
  if (!options.length) return { ...candidate.insight, ...copy };
  const variant = options[stableHash(`${seed}:copy:${candidate.insight.id}`) % options.length];
  return {
    ...candidate.insight,
    ...copy,
    detail: copy.detail ? `${copy.detail} ${variant}` : variant,
  };
}
