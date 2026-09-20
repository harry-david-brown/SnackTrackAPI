export const RECAP_POLICY_VERSION = 1;
export interface RecapScoreInput {
  value?: number;
  baseline?: number;
  comparisonCount?: number;
  share?: number;
  denominator?: number;
  refund?: boolean;
  magnitude: number;
}
const clamp = (value: number) => Math.max(0, Math.min(100, value));
export function scoreRecapStory(input: RecapScoreInput) {
  const surprise =
    input.baseline && input.baseline > 0 && input.value && input.value > 0
      ? clamp(50 * Math.log2(input.value / input.baseline)) *
        Math.min((input.comparisonCount ?? 0) / 8, 1)
      : 0;
  const habit =
    clamp((100 * (input.share ?? 0)) / (input.refund ? 0.25 : 0.6)) *
    Math.min((input.denominator ?? 0) / 20, 1);
  const magnitude = clamp(input.magnitude);
  return { surprise, habit, magnitude, score: 0.7 * Math.max(surprise, habit) + 0.3 * magnitude };
}
export function recapMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length
    ? sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2
    : 0;
}
