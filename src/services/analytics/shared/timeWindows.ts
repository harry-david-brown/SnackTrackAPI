/** Canonical SnackTrack late-night window: 10:00 PM inclusive to 4:00 AM exclusive. */
export const LATE_NIGHT_START_HOUR = 22;
export const LATE_NIGHT_END_HOUR = 4;

export const isLateNightHour = (hour: number | null | undefined): boolean =>
  hour !== null &&
  hour !== undefined &&
  Number.isInteger(hour) &&
  (hour >= LATE_NIGHT_START_HOUR || hour < LATE_NIGHT_END_HOUR);
