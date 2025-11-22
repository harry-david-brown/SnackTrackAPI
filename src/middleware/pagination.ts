/**
 * Pagination Middleware and Utilities
 * 
 * Provides standardized pagination for all endpoints
 */

import { Request, Response, NextFunction } from 'express';

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
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit as string) || 50));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Create pagination metadata for response
 */
export function createPaginationMeta(
  total: number,
  page: number,
  limit: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
    hasPrevious: page > 1
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
  limit: number
): PaginatedResponse<T> {
  return {
    data,
    pagination: createPaginationMeta(total, page, limit)
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

