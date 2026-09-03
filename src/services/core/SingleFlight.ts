/** Coalesces concurrent work for the same process-local key. */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const existing = this.inFlight.get(key) as Promise<Value> | undefined;
    if (existing) return existing;
    const promise = operation().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
