export interface ShutdownResource {
  readonly name: string;
  close(): void | Promise<void>;
}

export class ShutdownError extends Error {
  constructor(readonly failures: readonly Error[]) {
    super('One or more application resources failed to close');
    this.name = 'ShutdownError';
  }
}

/** Runs the process resource shutdown sequence at most once. */
export class ShutdownCoordinator {
  private closePromise: Promise<void> | null = null;

  constructor(private readonly resources: readonly ShutdownResource[]) {}

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeAll();
    return this.closePromise;
  }

  private async closeAll(): Promise<void> {
    const failures: Error[] = [];
    for (const resource of this.resources) {
      try {
        await resource.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(new Error(`Failed to close ${resource.name}: ${detail}`));
      }
    }
    if (failures.length > 0) {
      throw new ShutdownError(failures);
    }
  }
}
