/**
 * Data Source Priority Configuration
 * 
 * Defines the priority order for different data sources.
 * Higher priority sources override lower priority sources.
 */

export enum DataSourcePriority {
  CSV = 1,           // Highest priority - Uber's official data
  FINANCIAL = 2,     // Medium priority - Bank/credit card data
  EMAIL = 3          // Lowest priority - Parsed email receipts
}

export interface DataSourceConfig {
  priority: DataSourcePriority;
  name: string;
  description: string;
  isComplete: boolean;  // Whether this source provides complete data
  isReliable: boolean;  // Whether this source is considered reliable
}

export const DATA_SOURCE_CONFIGS: Record<string, DataSourceConfig> = {
  'csv': {
    priority: DataSourcePriority.CSV,
    name: 'CSV Import',
    description: 'Official Uber data export',
    isComplete: true,
    isReliable: true
  },
  'financial': {
    priority: DataSourcePriority.FINANCIAL,
    name: 'Financial Aggregator',
    description: 'Bank/credit card transaction data',
    isComplete: false,  // Limited to 1-2 years
    isReliable: true
  },
  'email': {
    priority: DataSourcePriority.EMAIL,
    name: 'Email Parsing',
    description: 'Parsed receipt emails',
    isComplete: false,  // Users delete emails
    isReliable: false  // Parsing can be error-prone
  }
};

/**
 * Get the priority of a data source
 */
export function getDataSourcePriority(source: string): DataSourcePriority {
  return DATA_SOURCE_CONFIGS[source]?.priority || DataSourcePriority.EMAIL;
}

/**
 * Check if a data source has higher priority than another
 */
export function hasHigherPriority(source1: string, source2: string): boolean {
  return getDataSourcePriority(source1) < getDataSourcePriority(source2);
}

/**
 * Get the highest priority data source from a list
 */
export function getHighestPrioritySource(sources: string[]): string {
  if (sources.length === 0) return '';
  
  return sources.reduce((highest, current) => {
    return hasHigherPriority(current, highest) ? current : highest;
  });
}
