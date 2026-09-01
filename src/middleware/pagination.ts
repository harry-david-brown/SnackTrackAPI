/**
 * Pagination Middleware and Utilities
 *
 * Provides standardized pagination for all endpoints
 */

import { Request, Response, NextFunction } from 'express';
import { parseQueryInteger } from '../http/validation/requestValues';

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  hasPrevious: boolean;
}

/**
 * Parse pagination parameters from query string
 * Defaults: page=1, limit=50
 * Max limit: 1000
 */
export function parsePagination(req: Request): PaginationParams {
  const page = parseQueryInteger(req.query.page, 'page', { defaultValue: 1, minimum: 1 })!;
  const limit = parseQueryInteger(req.query.limit, 'limit', {
    defaultValue: 50,
    minimum: 1,
    maximum: 1000,
  })!;
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Create pagination metadata for response
 */
export function createPaginationMeta(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
    hasPrevious: page > 1,
  };
}

/**
 * Standard paginated response format
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

/**
 * Create a standardized paginated response
 */
export function createPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResponse<T> {
  return {
    data,
    pagination: createPaginationMeta(total, page, limit),
  };
}

/**
 * Middleware to add pagination helpers to request object
 */
export function paginationMiddleware(req: Request, res: Response, next: NextFunction) {
  req.pagination = parsePagination(req);
  next();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      pagination?: PaginationParams;
    }
  }
}
