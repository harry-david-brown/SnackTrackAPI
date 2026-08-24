export const HYPOTHETICAL_ANNUAL_RETURN_PERCENT = 7;
export const HYPOTHETICAL_ANNUAL_RETURN_RATE = HYPOTHETICAL_ANNUAL_RETURN_PERCENT / 100;
export const AVERAGE_GREGORIAN_YEAR_DAYS = 365.2425;

export interface DatedContribution {
  amount: number;
  occurredAt: Date;
}

export interface HypotheticalInvestmentResult {
  contributed: number;
  futureValue: number;
  gains: number;
}

/**
 * Illustrative fixed-rate compounding. Each contribution starts growing from
 * its own event timestamp; future-dated and invalid contributions earn no
 * return rather than producing negative or misleading growth.
 */
export function calculateHypotheticalInvestment(
  contributions: DatedContribution[],
  asOf: Date,
  annualRate = HYPOTHETICAL_ANNUAL_RETURN_RATE,
): HypotheticalInvestmentResult {
  const asOfTime = asOf.getTime();
  const safeRate = Number.isFinite(annualRate) && annualRate > -1 ? annualRate : 0;
  let contributed = 0;
  let futureValue = 0;

  for (const contribution of contributions) {
    if (!Number.isFinite(contribution.amount) || contribution.amount <= 0) continue;
    contributed += contribution.amount;
    const occurredAt = contribution.occurredAt.getTime();
    if (!Number.isFinite(asOfTime) || !Number.isFinite(occurredAt) || occurredAt >= asOfTime) {
      futureValue += contribution.amount;
      continue;
    }
    const elapsedYears = (asOfTime - occurredAt) / (AVERAGE_GREGORIAN_YEAR_DAYS * 86_400_000);
    futureValue += contribution.amount * Math.pow(1 + safeRate, elapsedYears);
  }

  return { contributed, futureValue, gains: futureValue - contributed };
}
