import type { Request } from 'express';

export const ERROR_ENVELOPE_VERSION = '1' as const;

export interface ErrorEnvelopeV1 {
  readonly error: {
    readonly version: typeof ERROR_ENVELOPE_VERSION;
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly statusCode: number;
    readonly timestamp: string;
    readonly path: string;
    readonly method: string;
    readonly requestId: string;
    readonly stack?: string;
  };
}

export interface ErrorEnvelopeOptions {
  readonly details?: unknown;
  readonly stack?: string;
  readonly now?: Date;
}

/** Builds the only public operational-error representation used by HTTP routes. */
export const buildErrorEnvelopeV1 = (
  req: Pick<Request, 'originalUrl' | 'method' | 'requestId'>,
  statusCode: number,
  code: string,
  message: string,
  options: ErrorEnvelopeOptions = {},
): ErrorEnvelopeV1 => ({
  error: {
    version: ERROR_ENVELOPE_VERSION,
    code,
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
    statusCode,
    timestamp: (options.now ?? new Date()).toISOString(),
    path: req.originalUrl,
    method: req.method,
    requestId: req.requestId,
    ...(options.stack ? { stack: options.stack } : {}),
  },
});
