import type { Request } from 'express';
import { AuthenticationError } from '../core/errors';

/** Reads identity established by authentication middleware. */
export const authenticatedUserId = (request: Request): string => {
  const userId = request.user?.userId;
  if (!userId) throw new AuthenticationError();
  return userId;
};
