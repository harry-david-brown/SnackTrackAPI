// NYSE/Nasdaq full-day closures for the supported fund-history period (1999 onward).
const key = (d: Date) => d.toISOString().slice(0, 10);
const observed = (year: number, month: number, day: number) => {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCDay() === 6) d.setUTCDate(day - 1);
  if (d.getUTCDay() === 0) d.setUTCDate(day + 1);
  return key(d);
};
const nth = (year: number, month: number, weekday: number, n: number) => {
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCDate(1 + ((weekday - d.getUTCDay() + 7) % 7) + 7 * (n - 1));
  return key(d);
};
function goodFriday(year: number): string {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100;
  const d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(new Date(Date.UTC(year, month - 1, day - 2)));
}
const exceptional = new Set([
  '2001-09-11',
  '2001-09-12',
  '2001-09-13',
  '2001-09-14',
  '2004-06-11',
  '2007-01-02',
  '2012-10-29',
  '2012-10-30',
  '2018-12-05',
  '2025-01-09',
]);
export function isMarketSession(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`),
    y = d.getUTCFullYear();
  if ([0, 6].includes(d.getUTCDay()) || exceptional.has(date)) return false;
  const memorial = new Date(Date.UTC(y, 5, 0));
  memorial.setUTCDate(memorial.getUTCDate() - ((memorial.getUTCDay() + 6) % 7));
  const holidays = [
    nth(y, 1, 1, 3),
    nth(y, 2, 1, 3),
    goodFriday(y),
    key(memorial),
    observed(y, 7, 4),
    nth(y, 9, 1, 1),
    nth(y, 11, 4, 4),
    observed(y, 12, 25),
  ];
  // A Saturday New Year's Day does not close the preceding Friday.
  if (new Date(Date.UTC(y, 0, 1)).getUTCDay() !== 6) holidays.push(observed(y, 1, 1));
  if (y >= 2022) holidays.push(observed(y, 6, 19));
  return !holidays.includes(date);
}
export function marketSessions(start: string, end: string): string[] {
  const result: string[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) {
    const date = key(new Date(t));
    if (isMarketSession(date)) result.push(date);
  }
  return result;
}
