/**
 * Timezone utility functions
 * Converts UTC dates to user's local timezone for analytics calculations
 */

/**
 * Detect user's timezone from request headers
 * Mobile apps can send timezone in:
 * 1. X-Timezone header (preferred)
 * 2. X-User-Timezone header (alternative)
 * 3. Request body timezone field (fallback)
 * 
 * @param req - Express request object
 * @returns IANA timezone string or null if not detected
 */
export function detectTimezoneFromRequest(req: any): string | null {
  // Check for explicit timezone header (mobile apps should send this)
  const timezoneHeader = req.headers['x-timezone'] || req.headers['x-user-timezone'];
  if (isValidTimezone(timezoneHeader)) {
    return timezoneHeader;
  }

  // Check request body for timezone (optional field)
  if (req.body && req.body.timezone && typeof req.body.timezone === 'string') {
    if (isValidTimezone(req.body.timezone)) {
      return req.body.timezone;
    }
  }

  // Could also try to detect from Accept-Language header, but this is less reliable
  // For now, return null and let the service use the default

  return null;
}

/**
 * Get default timezone (fallback when detection fails)
 */
export function getDefaultTimezone(): string {
  return 'America/New_York';
}

/** Validate an IANA timezone using the runtime's timezone database. */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 100) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a UTC Date to a Date object representing the same moment in the user's timezone
 * This allows us to use getHours(), getDay(), etc. with the correct local time
 * 
 * @param utcDate - The UTC date (stored in database)
 * @param timezone - IANA timezone string (e.g., 'America/New_York', 'Europe/London')
 * @returns A Date object that, when using getHours(), getDay(), etc., will return values in the user's timezone
 */
export function convertToLocalTime(utcDate: Date, timezone: string = 'America/New_York'): Date {
  if (!utcDate) return utcDate;
  
  // Get the date/time string in the user's timezone
  const localTimeString = utcDate.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  // Parse the local time string back to a Date object
  // Format: "MM/DD/YYYY, HH:MM:SS"
  const [datePart, timePart] = localTimeString.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hours, minutes, seconds] = timePart.split(':').map(Number);
  
  // Create a new Date object with the local time components
  // Note: This creates a Date in the server's local timezone, but we'll use it
  // only for extracting hour/day values, not for actual time calculations
  const localDate = new Date(year, month - 1, day, hours, minutes, seconds);
  
  return localDate;
}

// Cache formatters per timezone to avoid recreating them thousands of times
const hourFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const localPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getHourFormatter(timezone: string): Intl.DateTimeFormat {
  if (!hourFormatterCache.has(timezone)) {
    hourFormatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false
    }));
  }
  return hourFormatterCache.get(timezone)!;
}

function getDayFormatter(timezone: string): Intl.DateTimeFormat {
  if (!dayFormatterCache.has(timezone)) {
    dayFormatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long'
    }));
  }
  return dayFormatterCache.get(timezone)!;
}

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  if (!dateFormatterCache.has(timezone)) {
    dateFormatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }));
  }
  return dateFormatterCache.get(timezone)!;
}

function getLocalPartsFormatter(timezone: string): Intl.DateTimeFormat {
  if (!localPartsFormatterCache.has(timezone)) {
    localPartsFormatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return localPartsFormatterCache.get(timezone)!;
}

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Return local calendar components without creating a host-timezone Date. */
export function getLocalDateTimeParts(
  utcDate: Date | null,
  timezone: string = 'America/New_York'
): LocalDateTimeParts | null {
  if (!utcDate || Number.isNaN(utcDate.getTime()) || !isValidTimezone(timezone)) return null;

  const parts = getLocalPartsFormatter(timezone).formatToParts(utcDate);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === type)?.value);
  const result = {
    year: numberPart('year'),
    month: numberPart('month'),
    day: numberPart('day'),
    hour: numberPart('hour'),
    minute: numberPart('minute'),
    second: numberPart('second'),
  };

  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function getLocalDateKey(
  utcDate: Date | null,
  timezone: string = 'America/New_York'
): string | null {
  const parts = getLocalDateTimeParts(utcDate, timezone);
  if (!parts) return null;
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

export function getLocalYear(
  utcDate: Date | null,
  timezone: string = 'America/New_York'
): number | null {
  return getLocalDateTimeParts(utcDate, timezone)?.year ?? null;
}

export function getLocalMinuteOfDay(
  utcDate: Date | null,
  timezone: string = 'America/New_York'
): number | null {
  const parts = getLocalDateTimeParts(utcDate, timezone);
  return parts ? parts.hour * 60 + parts.minute : null;
}

export function formatTimeInTimezone(
  utcDate: Date | null,
  timezone: string = 'America/New_York'
): string | null {
  if (!utcDate || Number.isNaN(utcDate.getTime()) || !isValidTimezone(timezone)) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(utcDate);
}

/** Convert local wall-clock components in an IANA timezone to a UTC instant. */
export function zonedDateTimeToUtc(
  local: LocalDateTimeParts,
  timezone: string
): Date | null {
  if (!isValidTimezone(timezone)) return null;

  const desiredAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );
  let candidate = new Date(desiredAsUtc);

  // Two passes handle offset changes around DST boundaries.
  for (let attempt = 0; attempt < 2; attempt++) {
    const represented = getLocalDateTimeParts(candidate, timezone);
    if (!represented) return null;
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second
    );
    candidate = new Date(candidate.getTime() + (desiredAsUtc - representedAsUtc));
  }

  const finalParts = getLocalDateTimeParts(candidate, timezone);
  if (!finalParts || Object.keys(local).some(key =>
    finalParts[key as keyof LocalDateTimeParts] !== local[key as keyof LocalDateTimeParts]
  )) {
    return null;
  }
  return candidate;
}

/** Parse the date/time strings extracted from a receipt as the user's local wall time. */
export function parseReceiptLocalDateTime(
  dateText: string | null,
  timeText: string | null,
  timezone: string
): Date | null {
  if (!dateText || !timeText) return null;

  const monthNames: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const wordDate = dateText.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  const numericDate = dateText.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  let year: number;
  let month: number;
  let day: number;

  if (wordDate && monthNames[wordDate[1].toLowerCase()]) {
    month = monthNames[wordDate[1].toLowerCase()];
    day = Number(wordDate[2]);
    year = Number(wordDate[3]);
  } else if (numericDate) {
    month = Number(numericDate[1]);
    day = Number(numericDate[2]);
    year = Number(numericDate[3]);
    if (year < 100) year += 2000;
  } else {
    return null;
  }

  const time = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)$/i);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const isPm = /^p/i.test(time[3]);
  if (hour === 12) hour = 0;
  if (isPm) hour += 12;

  return zonedDateTimeToUtc({ year, month, day, hour, minute, second: 0 }, timezone);
}

/**
 * Get the hour in the user's timezone from a UTC date
 * @param utcDate - The UTC date
 * @param timezone - IANA timezone string
 * @returns Hour (0-23) in user's timezone
 */
export function getLocalHour(utcDate: Date | null, timezone: string = 'America/New_York'): number | null {
  const minuteOfDay = getLocalMinuteOfDay(utcDate, timezone);
  return minuteOfDay === null ? null : Math.floor(minuteOfDay / 60);
}

/**
 * Get the day of week (0-6, Sunday-Saturday) in the user's timezone
 * @param utcDate - The UTC date
 * @param timezone - IANA timezone string
 * @returns Day of week (0 = Sunday, 6 = Saturday) in user's timezone
 */
export function getLocalDay(utcDate: Date | null, timezone: string = 'America/New_York'): number | null {
  if (!utcDate) return null;
  
  // Use cached formatter to avoid recreating it thousands of times
  const formatter = getDayFormatter(timezone);
  const parts = formatter.formatToParts(utcDate);
  
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '0', 10);
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '0', 10) - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '0', 10);
  
  // Create a date object with these components (in server's local timezone)
  // This is fine because we only use getDay() which gives us the day of week
  const localDateObj = new Date(year, month, day);
  return localDateObj.getDay();
}

/**
 * Get a Date object that represents the same moment but with local time components
 * This is a more reliable method for getting local time components
 */
export function getLocalDate(utcDate: Date | null, timezone: string = 'America/New_York'): Date | null {
  if (!utcDate) return null;
  
  // Use cached formatter to avoid recreating it thousands of times
  const formatter = getDateFormatter(timezone);
  const parts = formatter.formatToParts(utcDate);
  
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '0', 10);
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '0', 10) - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '0', 10);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const second = parseInt(parts.find(p => p.type === 'second')?.value || '0', 10);
  
  // Create a date object with these components
  // Note: This creates a date in the server's timezone, but we only use it
  // for extracting hour/day values, not for time calculations
  return new Date(year, month, day, hour, minute, second);
}
