export interface AuthAbuseBudgetPort {
  /** Atomically count the attempt; return seconds until reset if over budget. */
  consume(key: string, maximum: number, windowSeconds: number): Promise<number>;
}
