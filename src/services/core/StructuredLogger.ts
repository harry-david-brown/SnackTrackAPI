export interface StructuredLogContext extends Readonly<Record<string, unknown>> {
  readonly requestId?: string;
  readonly userId?: string;
  readonly operation?: string;
  readonly importId?: string;
  readonly provider?: string;
  readonly durationMs?: number;
  readonly outcome?: string;
  readonly errorCode?: string | null;
}

export interface StructuredLogger {
  debug(message: string, context?: StructuredLogContext): void;
  info(message: string, context?: StructuredLogContext): void;
  warn(message: string, context?: StructuredLogContext): void;
  error(message: string, context?: StructuredLogContext): void;
}

export const silentStructuredLogger: StructuredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
