/**
 * Major Fast Food Chain Configuration
 * 
 * This file contains a curated list of major fast food chains
 * for consolidating spending across multiple locations.
 */

export interface ChainMapping {
  [chainName: string]: string[];
}

// Major fast food chains with common variations in naming
export const MAJOR_CHAINS: ChainMapping = {
  'McDonald\'s': [
    'McDonald\'s',
    'McDonalds',
    'McDonald'
  ],
  'Burger King': [
    'Burger King',
    'BK'
  ],
  'Wendy\'s': [
    'Wendy\'s',
    'Wendys'
  ],
  'Subway': [
    'Subway'
  ],
  'Taco Bell': [
    'Taco Bell'
  ],
  'KFC': [
    'KFC',
    'Kentucky Fried Chicken'
  ],
  'Pizza Hut': [
    'Pizza Hut'
  ],
  'Domino\'s': [
    'Domino\'s',
    'Dominos'
  ],
  'Papa John\'s': [
    'Papa John\'s',
    'Papa Johns'
  ],
  'Starbucks': [
    'Starbucks'
  ],
  'Tim Hortons': [
    'Tim Hortons',
    'Tim\'s'
  ],
  'Dunkin\'': [
    'Dunkin\'',
    'Dunkin Donuts',
    'Dunkin'
  ],
  'Chipotle': [
    'Chipotle'
  ],
  'Five Guys': [
    'Five Guys'
  ],
  'Popeyes': [
    'Popeyes',
    'Popeye\'s'
  ],
  'A&W': [
    'A&W'
  ],
  'Harvey\'s': [
    'Harvey\'s',
    'Harveys'
  ],
  'Swiss Chalet': [
    'Swiss Chalet'
  ],
  'Boston Pizza': [
    'Boston Pizza'
  ],
  'Little Caesars': [
    'Little Caesars'
  ],
  'Arby\'s': [
    'Arby\'s',
    'Arbys'
  ],
  'Carl\'s Jr.': [
    'Carl\'s Jr.',
    'Carls Jr'
  ],
  'Jack in the Box': [
    'Jack in the Box'
  ],
  'White Castle': [
    'White Castle'
  ],
  'In-N-Out': [
    'In-N-Out'
  ],
  'Chick-fil-A': [
    'Chick-fil-A',
    'Chick-fil-A'
  ],
  'Sonic': [
    'Sonic'
  ],
  'Culver\'s': [
    'Culver\'s',
    'Culvers'
  ],
  'Whataburger': [
    'Whataburger'
  ],
  'Shake Shack': [
    'Shake Shack'
  ]
};

/**
 * Determines if a restaurant name belongs to a major chain
 * @param restaurantName The restaurant name to check
 * @returns The chain name if it's a major chain, null otherwise
 */
export function getChainName(restaurantName: string): string | null {
  if (!restaurantName) return null;
  
  const normalizedName = restaurantName.trim();
  
  for (const [chainName, variations] of Object.entries(MAJOR_CHAINS)) {
    for (const variation of variations) {
      if (normalizedName.toLowerCase().includes(variation.toLowerCase())) {
        return chainName;
      }
    }
  }
  
  return null;
}

/**
 * Gets all major chain names
 * @returns Array of all major chain names
 */
export function getAllChainNames(): string[] {
  return Object.keys(MAJOR_CHAINS);
}
