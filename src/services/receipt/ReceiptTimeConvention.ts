/** Currency-scoped city evidence avoids guessing between same-name cities in different countries. */
export function exportCityTimezone(city: string, currency: string, fallback: string): string {
  const key = city.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const zones: Record<string, Record<string,string>> = {
    CAD: { ottawa:'America/Toronto',toronto:'America/Toronto',montreal:'America/Toronto',quebec:'America/Toronto',vancouver:'America/Vancouver',calgary:'America/Edmonton',edmonton:'America/Edmonton',winnipeg:'America/Winnipeg',halifax:'America/Halifax',regina:'America/Regina' },
    USD: { 'new york':'America/New_York',boston:'America/New_York',chicago:'America/Chicago',seattle:'America/Los_Angeles','los angeles':'America/Los_Angeles','san francisco':'America/Los_Angeles',denver:'America/Denver',phoenix:'America/Phoenix' },
    GBP: { london:'Europe/London',manchester:'Europe/London',edinburgh:'Europe/London' },
  };
  return zones[currency.trim().toUpperCase()]?.[key] ?? fallback;
}

export function exportAddressCurrency(address: string): { currencyCode: 'CAD' | 'USD' | 'UNKNOWN'; currencyInference?: 'canadian_postal' | 'explicit_country' } {
  if (/\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d\b/i.test(address)) return {currencyCode:'CAD',currencyInference:'canadian_postal'};
  if (/\b(?:USA|United States)\b/i.test(address)) return {currencyCode:'USD',currencyInference:'explicit_country'};
  if (/\bCanada\b/i.test(address)) return {currencyCode:'CAD',currencyInference:'explicit_country'};
  return {currencyCode:'UNKNOWN'};
}
