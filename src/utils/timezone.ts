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
  if (timezoneHeader && typeof timezoneHeader === 'string') {
    // Validate it's a reasonable IANA timezone format
    // IANA timezones are typically: Continent/City (e.g., America/New_York, Europe/London)
    // Allow underscores and hyphens in city names
    if (/^[A-Za-z_]+\/[A-Za-z_]+$/.test(timezoneHeader) && !timezoneHeader.includes('//')) {
      return timezoneHeader;
    }
  }

  // Check request body for timezone (optional field)
  if (req.body && req.body.timezone && typeof req.body.timezone === 'string') {
    // Same validation as header
    if (/^[A-Za-z_]+\/[A-Za-z_]+$/.test(req.body.timezone) && !req.body.timezone.includes('//')) {
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

/**
 * Get the hour in the user's timezone from a UTC date
 * @param utcDate - The UTC date
 * @param timezone - IANA timezone string
 * @returns Hour (0-23) in user's timezone
 */
export function getLocalHour(utcDate: Date | null, timezone: string = 'America/New_York'): number | null {
  if (!utcDate) return null;
  
  // Use Intl.DateTimeFormat to get the hour directly in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false
  });
  
  const hour = parseInt(formatter.format(utcDate), 10);
  return hour;
}

/**
 * Get the day of week (0-6, Sunday-Saturday) in the user's timezone
 * @param utcDate - The UTC date
 * @param timezone - IANA timezone string
 * @returns Day of week (0 = Sunday, 6 = Saturday) in user's timezone
 */
export function getLocalDay(utcDate: Date | null, timezone: string = 'America/New_York'): number | null {
  if (!utcDate) return null;
  
  // Get the date components in the user's timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  }).formatToParts(utcDate);
  
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
  
  // Get all date components in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
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
