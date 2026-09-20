import type { OrderSourceEvidence, OrderTimestamp } from '../../models/OrderEvidence';
import { getLocalDateKey, getLocalDateTimeParts, zonedDateTimeToUtc } from '../../utils/timezone';

interface ParsedTimestamp {
  date: Date;
  evidence: OrderTimestamp;
  ambiguous: boolean;
}

/** DoorDash offsets are real offsets; do not apply Uber's *_Local/Z convention here. */
function timestamp(
  raw: string,
  role: 'placed' | 'delivered',
  timezone: string,
): ParsedTimestamp | null {
  const match = raw
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
  };
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  )
    return null;
  const precision = hour === undefined ? 'day' : second === undefined ? 'minute' : 'second';
  let date = offset
    ? new Date(
        `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}${fraction ? `.${fraction}` : ''}${offset.toUpperCase()}`,
      )
    : zonedDateTimeToUtc(parts, timezone);
  if (!date || !Number.isFinite(date.getTime())) return null;
  // A repeated DST wall time has two plausible instants. Keep its local-day evidence,
  // but do not claim an exact interval or hour-of-day story without an explicit offset.
  const ambiguous =
    !offset &&
    precision !== 'day' &&
    [-86400000, 86400000].some((shift) => {
      const sample = new Date(date!.getTime() + shift);
      const represented = getLocalDateTimeParts(sample, timezone);
      if (!represented) return false;
      const offset =
        Date.UTC(
          represented.year,
          represented.month - 1,
          represented.day,
          represented.hour,
          represented.minute,
          represented.second,
        ) - sample.getTime();
      const alternateDate = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
          offset,
      );
      if (alternateDate.getTime() === date!.getTime()) return false;
      const alternate = getLocalDateTimeParts(alternateDate, timezone);
      return (
        alternate &&
        Object.entries(parts).every(
          ([key, value]) => alternate[key as keyof typeof parts] === value,
        )
      );
    });
  if (!offset && fraction) date = new Date(date.getTime() + Number(`0.${fraction}`) * 1000);
  return {
    date,
    ambiguous,
    evidence: {
      role,
      raw,
      precision,
      ...(precision !== 'day' && !ambiguous ? { instant: date.toISOString() } : {}),
    },
  };
}

export function doorDashExportEvidence(
  placedRaw: string,
  deliveredRaw: string,
  timezone: string,
  allowedDates: { earliest: number; latest: number },
) {
  const validDate = (value: ParsedTimestamp | null): value is ParsedTimestamp =>
    Boolean(
      value &&
      value.date.getTime() >= allowedDates.earliest &&
      value.date.getTime() <= allowedDates.latest,
    );
  const placed = timestamp(placedRaw, 'placed', timezone);
  if (!validDate(placed)) return null;
  const candidate = timestamp(deliveredRaw, 'delivered', timezone);
  const delivered =
    validDate(candidate) &&
    (placed.evidence.instant && candidate.evidence.instant
      ? candidate.date >= placed.date
      : getLocalDateKey(candidate.date, timezone)! >= getLocalDateKey(placed.date, timezone)!)
      ? candidate
      : null;
  const issues = [
    'Final charge is not supplied by this export',
    ...(delivered
      ? ['Fulfillment is supported by the delivery timestamp; no status column is supplied']
      : ['Fulfillment is unknown without a usable delivery timestamp']),
    ...(deliveredRaw.trim() && !delivered
      ? ['Invalid or inconsistent delivery timestamp retained in source rows']
      : []),
    ...([placed, delivered].some((t) => t?.ambiguous)
      ? ['Ambiguous local timestamp; exact timing is unavailable without an offset']
      : []),
  ];
  const evidence: OrderSourceEvidence = {
    version: 1,
    parserVersion: 3,
    documentKind: 'export',
    fulfillment: delivered ? 'completed' : 'unknown',
    recordedTotal: null,
    totalState: 'unavailable',
    payments: [],
    issues,
    timestamps: [placed.evidence, ...(delivered ? [delivered.evidence] : [])],
  };
  return {
    orderDate: placed.date,
    deliveryTime:
      placed.evidence.instant && delivered?.evidence.instant ? delivered.date : undefined,
    precision: placed.evidence.instant ? ('minute' as const) : ('day' as const),
    evidence,
  };
}

/** Preserve the export's documented placement+delivery grouping, normalizing equivalent offsets. */
export function doorDashDeliveryIdentity(raw: string, timezone: string): string {
  const parsed = timestamp(raw, 'delivered', timezone);
  if (!parsed) return `unknown:${raw.trim()}`;
  if (parsed.evidence.instant) return `instant:${parsed.evidence.instant}`;
  return `${parsed.evidence.precision}:${raw.trim().replace(' ', 'T')}`;
}
