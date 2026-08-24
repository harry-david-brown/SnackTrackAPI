import { DashboardInsightIcon } from './types';

export interface ItemPersonalityProfile {
  patterns: RegExp[];
  unitPatterns?: readonly RegExp[];
  label: string;
  minimumUnits: number;
  maximumUnits: number;
  icon: DashboardInsightIcon;
  punchlines: readonly string[];
}

/**
 * Single source of truth for item-obsession cards. Adding a supported item
 * type should require only one entry here: detection, display, eligibility,
 * icon, and personality all travel together.
 */
export const ITEM_PERSONALITY_PROFILES = {
  coffee: {
    patterns: [/\b(?:coffee|latte|cappuccino|espresso|americano|cold brew|frappuccino|frappe|mocha)\b/], label: 'coffees', minimumUnits: 5, maximumUnits: 5000, icon: 'meal',
    punchlines: ['At this point, your blood type is cold brew.', 'Sleep was apparently a negotiable expense.', 'Decaf never had a fighting chance.', 'Caffeine stayed on the guest list.'],
  },
  cookie: {
    patterns: [/\b(?:cookie|cookies|biscuit)\b/], label: 'cookies', minimumUnits: 4, maximumUnits: 5000, icon: 'sparkles',
    punchlines: ['Cookie Monster knows your order by heart.', 'That cookie jar needs witness protection.', 'Chocolate chips had a permanent invite.', 'Sesame Street has opened an investigation.'],
  },
  hash_brown: {
    patterns: [/\bhash browns?\b/], label: 'hash browns', minimumUnits: 4, maximumUnits: 5000, icon: 'sparkles',
    punchlines: ['Potatoes died crispy so your mornings could live.', 'You turned shredded potato into a personality trait.', 'Breakfast without crunch was never on the table.', 'The fryer saw you coming.'],
  },
  fries: {
    patterns: [/\bfries\b|\bfrench fry\b/], label: 'fries', minimumUnits: 5, maximumUnits: 5000, icon: 'sparkles',
    punchlines: ['The fries were the point.', 'Side dish? Be serious.', 'Ketchup has been carrying this relationship.', 'Sharing was never in the terms and conditions.'],
  },
  nugget: {
    patterns: [/\b(?:mcnuggets?|nuggets?)\b/], label: 'nuggets', minimumUnits: 20, maximumUnits: 50000, icon: 'sparkles',
    unitPatterns: [/\b(\d{1,3})\s*(?:piece\s*)?(?:mc)?nuggets?\b/],
    punchlines: ['At this volume, they stop being nuggets and become inventory.', 'You could field a small, heavily breaded army.', 'The dipping sauces deserve overtime.', 'Somewhere, a 20-piece box is trembling.'],
  },
  fried_chicken: {
    patterns: [/\b(?:fried chicken|chicken pieces?|wings?|drumsticks?|tenders?)\b/], label: 'fried-chicken pieces', minimumUnits: 8, maximumUnits: 10000, icon: 'sparkles',
    unitPatterns: [/\b(\d{1,3})\s*(?:piece|pc)\b/],
    punchlines: ['That’s enough crunch to register on a seismograph.', 'You did not come here for subtle seasoning.', 'Your napkin budget must be obscene.', 'Wings were not a phase. They were policy.'],
  },
  sauce: {
    patterns: [/\b(?:sauce|dip|dipping)\b/], label: 'dipping sauces', minimumUnits: 6, maximumUnits: 10000, icon: 'sparkles',
    punchlines: ['Dry bites were never an option.', 'You treated sauce limits as a personal attack.', 'The meal was just a delivery system for dip.', 'Some people collect art. You collected sauce cups.'],
  },
  burger: {
    patterns: [/\b(?:burger|cheeseburger|hamburger|big mac|whopper)\b/], label: 'burgers', minimumUnits: 5, maximumUnits: 5000, icon: 'meal',
    punchlines: ['You looked at the menu and chose violence between two buns.', 'Vegetables mostly appeared as witnesses.', 'The cow-to-bun pipeline stayed busy.', 'Your answer to “what should we eat?” had two buns.'],
  },
  pizza: {
    patterns: [/\b(?:pizza|pizzas)\b/], label: 'pizzas', minimumUnits: 4, maximumUnits: 5000, icon: 'meal',
    punchlines: ['Pizza again wasn’t a question. It was the answer.', 'One more order and Italy sends an invoice.', 'Pepperoni was basically a recurring bill.', 'Your doorbell heard “pizza” and stopped asking questions.'],
  },
  taco: {
    patterns: [/\b(?:taco|tacos)\b/], label: 'tacos', minimumUnits: 6, maximumUnits: 10000, icon: 'meal',
    punchlines: ['Taco Tuesday escaped containment.', 'You folded dinner and called it a lifestyle.', 'The calendar ran out of Tuesdays.', 'The shells cracked under pressure. You didn’t.'],
  },
  burrito: {
    patterns: [/\b(?:burrito|burritos)\b/], label: 'burritos', minimumUnits: 4, maximumUnits: 5000, icon: 'meal',
    punchlines: ['Your order history is suspiciously cylindrical.', 'The foil did not die in vain.', 'That’s a lot of dinner wearing a sleeping bag.', 'You chose the food equivalent of a weighted blanket.'],
  },
  sandwich: {
    patterns: [/\b(?:sandwich|sub|hoagie|panini)\b/], label: 'sandwiches', minimumUnits: 5, maximumUnits: 5000, icon: 'meal',
    punchlines: ['You keep putting meals between bread like it solves everything.', 'The bread was doing load-bearing work.', 'Open-faced was never an option.', 'Two slices. Zero hesitation.'],
  },
  donut: {
    patterns: [/\b(?:donut|donuts|doughnut|doughnuts)\b/], label: 'donuts', minimumUnits: 4, maximumUnits: 5000, icon: 'sparkles',
    punchlines: ['Your breakfast came with a hole and zero alibis.', 'That donut box needs a restraining order.', 'You treated glaze like a food group.', 'Homer Simpson numbers.'],
  },
  ice_cream: {
    patterns: [/\b(?:ice cream|sundae|gelato|soft serve)\b/], label: 'frozen treats', minimumUnits: 4, maximumUnits: 5000, icon: 'sparkles',
    punchlines: ['Your freezer watched this happen and felt useless.', 'Brain freeze was apparently an acceptable tax.', 'Melting was the only deadline you respected.', 'The spoon barely had time to thaw.'],
  },
  bubble_tea: {
    patterns: [/\b(?:bubble tea|boba|milk tea)\b/], label: 'bubble teas', minimumUnits: 4, maximumUnits: 5000, icon: 'meal',
    punchlines: ['You paid extra to chew your drink. Repeatedly.', 'Your beverages had side quests.', 'The giant straw has seen things.', 'At this point, the pearls know your order.'],
  },
  soda: {
    patterns: [/\b(?:soda|soft drink|cola|coke|pepsi|sprite|root beer)\b/], label: 'soft drinks', minimumUnits: 6, maximumUnits: 10000, icon: 'meal',
    punchlines: ['Water watched from the bench.', 'Flat was never an option.', 'Your drink needed sound effects.', 'Carbonation did some heavy lifting here.'],
  },
  milkshake: {
    patterns: [/\b(?:milkshake|milk shake|shake)\b/], label: 'milkshakes', minimumUnits: 4, maximumUnits: 5000, icon: 'meal',
    punchlines: ['You looked at ice cream and said “make it drinkable.”', 'That straw fought for its life.', 'The blender deserves hazard pay.', 'Milk had no business being this dramatic.'],
  },
  bagel: {
    patterns: [/\b(?:bagel|bagels)\b/], label: 'bagels', minimumUnits: 4, maximumUnits: 5000, icon: 'meal',
    punchlines: ['That schmear was structural, not decorative.', 'Your toaster knew the assignment.', 'Breakfast had a hole in it. You kept ordering anyway.', 'Somewhere, a plain bagel is offended.'],
  },
} as const satisfies Record<string, ItemPersonalityProfile>;

export type ItemPersonalityFamily = keyof typeof ITEM_PERSONALITY_PROFILES;

export function classifyItemPersonality(key: string): ItemPersonalityFamily | 'other' {
  for (const [family, profile] of Object.entries(ITEM_PERSONALITY_PROFILES) as Array<[ItemPersonalityFamily, ItemPersonalityProfile]>) {
    if (profile.patterns.some(pattern => pattern.test(key))) return family;
  }
  return 'other';
}

export function getItemPersonality(family: ItemPersonalityFamily): ItemPersonalityProfile {
  return ITEM_PERSONALITY_PROFILES[family];
}

export function getItemPhysicalMultiplier(key: string, family: ItemPersonalityFamily | 'other'): number {
  const genericPack = key.match(/\b(\d{1,3})\s*(?:pack|pk|piece|pc|count|ct)\b/);
  if (genericPack) return Number(genericPack[1]);
  if (family !== 'other') {
    const profile: ItemPersonalityProfile = ITEM_PERSONALITY_PROFILES[family];
    for (const pattern of profile.unitPatterns ?? []) {
      const match = key.match(pattern);
      if (match) return Number(match[1]);
    }
  }
  return 1;
}

export const GENERIC_ITEM_PUNCHLINES = [
  'This stopped being a favourite and became muscle memory.',
  'The menu changed. Your thumb didn’t.',
  'At this point, ordering it was a reflex.',
  'You could have ordered anything. Apparently not.',
] as const;
