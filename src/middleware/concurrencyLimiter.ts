import { Request, Response, NextFunction } from 'express';

const MAX_CONCURRENT_REQUESTS = 100;
let activeRequests = 0;
const requestQueue: Array<() => void> = [];

/**
 * Simple concurrency limiter for Express routes.
 * Queues requests when the maximum number of active handlers is reached.
 */
export function concurrencyLimiter(req: Request, res: Response, next: NextFunction): void {
  const start = () => {
    activeRequests++;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      const nextInQueue = requestQueue.shift();
      if (nextInQueue) {
        nextInQueue();
      }
    };

    res.on('finish', release);
    res.on('close', release);

    // If the request was already aborted while waiting, release immediately
    if (req.destroyed || req.aborted) {
      return release();
    }

    next();
  };

  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    start();
  } else {
    requestQueue.push(start);
  }
}