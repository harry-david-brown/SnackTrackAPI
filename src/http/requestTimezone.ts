import type { Request } from 'express';
import { detectTimezone } from '../utils/timezone';

/** HTTP adapter for the framework-independent timezone detector. */
export const requestTimezone = (request: Request): string | null =>
  detectTimezone({
    primaryHeader: request.headers['x-timezone'],
    fallbackHeader: request.headers['x-user-timezone'],
    body: request.body as unknown,
  });
