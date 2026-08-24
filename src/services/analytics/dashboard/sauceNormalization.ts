import { NormalizedItem } from './normalization';

interface SauceAlias {
  label: string;
  patterns: readonly RegExp[];
}

const SAUCE_ALIASES: readonly SauceAlias[] = [
  { label: 'Ghost Pepper Ranch', patterns: [/\bghost pepper ranch\b/] },
  { label: 'Blackened Ranch', patterns: [/\bblackened ranch\b/] },
  { label: 'Creamy Garlic', patterns: [/\bcreamy garlic(?: sauce)?\b/] },
  { label: 'Garlic Dipping Sauce', patterns: [/\b(?:special garlic sauce|garlic dipping sauce)\b/] },
  { label: 'Garlic Aioli', patterns: [/\bgarlic aioli(?: dipping sauce)?\b/] },
  { label: 'Hot Mustard', patterns: [/\bhot mustard\b/] },
  { label: 'Honey Mustard', patterns: [/\bhoney mustard\b/] },
  { label: 'Sweet & Sour', patterns: [/\bsweet (?:&|and|n) sour(?: sauce)?\b/] },
  { label: 'Barbecue', patterns: [/\b(?:bbq|barbeque|barbecue)(?: sauce)?\b/] },
  { label: 'Bayou Buffalo', patterns: [/\bbayou buffalo\b/] },
  { label: 'Buffalo', patterns: [/\bbuffalo(?: sauce)?\b/] },
  { label: 'BFF Sauce', patterns: [/\bbff sauce\b/] },
  { label: "Frankie's Signature Dip", patterns: [/\bfrankie'?s signature dip\b/] },
  { label: 'Habanero', patterns: [/\bhabanero(?: sauce|dip)?\b/] },
  { label: 'Chipotle', patterns: [/\bchipotle(?: sauce|dip)?\b/] },
  { label: 'Plum Sauce', patterns: [/\bplum sauce\b/] },
  { label: 'Caramel', patterns: [/\bcaramel dip\b/] },
  { label: 'Tzatziki', patterns: [/\btzatziki(?: sauce)?\b/] },
  { label: 'Ranch', patterns: [/\branch(?: sauce)?\b/] },
  { label: 'Ketchup', patterns: [/\bketchup packets?\b/] },
];

const DIP_CONTEXT = /\b(?:dipping sauce|sauce cups?|(?:mc)?nuggets?|tenders?|chicken strips?|wings?|fries|funnel cake stix)\b/;
const EXCLUDED_CONDIMENT = /\b(?:pizza|tomato|big mac|mayo(?:-style)?|mocha|regular) sauce\b|\bgarlic sauce\s*&\s*tahini\b|\bsauce drizzle\b/;
const EXPLICIT_SAUCE_NAME = /\b(?:sauce|dip|ranch|aioli|mustard|ketchup packets?)\b$/;
const GENERIC_SAUCE_NAME = /^(?:dipping )?sauce$/;

function normalizedText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[®™©]/g, '')
    .replace(/\[[^\]]*\bcal(?:s|ories)?\b[^\]]*\]/gi, '')
    .replace(/\([^)]*\bcal(?:s|ories)?\b[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasFor(value: string) {
  const candidate = normalizedText(value).toLocaleLowerCase('en-US');
  if (!candidate || EXCLUDED_CONDIMENT.test(candidate)) return null;
  return SAUCE_ALIASES.find(alias => alias.patterns.some(pattern => pattern.test(candidate)))?.label ?? null;
}

function fallbackLabel(value: string) {
  const candidate = normalizedText(value);
  const lower = candidate.toLocaleLowerCase('en-US');
  if (!candidate || candidate.length > 48 || EXCLUDED_CONDIMENT.test(lower) || GENERIC_SAUCE_NAME.test(lower) || !EXPLICIT_SAUCE_NAME.test(lower)) return null;
  return candidate.replace(/\b\p{L}/gu, character => character.toLocaleUpperCase('en-US'));
}

export function extractDippingSauceLabels(item: NormalizedItem): string[] {
  const labels = new Set<string>();
  const itemName = normalizedText(item.label);
  const itemKey = normalizedText(item.key).toLocaleLowerCase('en-US');
  const genericSauceItem = GENERIC_SAUCE_NAME.test(itemKey);
  const directAlias = aliasFor(itemName);
  const exactAlias = directAlias && directAlias.toLocaleLowerCase('en-US') === itemKey ? directAlias : null;
  const direct = EXPLICIT_SAUCE_NAME.test(itemKey) ? directAlias ?? fallbackLabel(itemName) : exactAlias;
  if (direct && !genericSauceItem) labels.add(direct);

  if (genericSauceItem || DIP_CONTEXT.test(itemKey)) {
    for (const customization of item.customizations) {
      const label = aliasFor(customization) ?? fallbackLabel(customization);
      if (label) labels.add(label);
    }
  }
  return [...labels];
}
