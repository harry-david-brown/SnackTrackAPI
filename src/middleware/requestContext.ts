import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Establishes one correlation identifier before any security or route middleware runs. */
export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const supplied = req.get('X-Request-ID');
  req.requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
};
