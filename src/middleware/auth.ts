/**
 * Authentication Middleware
 * 
 * Handles JWT token validation and user authentication
 */

import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/AuthService';
import { container } from '../services/core/ServiceContainer';
import { AuthenticationError, AuthorizationError } from './errorHandler';
import { TokenPayload } from '../models/Token';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Middleware to authenticate requests using JWT
 * Extracts token from Authorization header and validates it
 */
export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      throw new AuthenticationError('Access token is required');
    }

    // Get auth service from container
    const authService = container.get<AuthService>('authService');

    // Verify token and extract user data
    const decoded = authService.verifyAccessToken(token);

    // Attach user to request
    req.user = decoded;

    next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      next(error);
    } else {
      next(new AuthenticationError('Invalid or expired token'));
    }
  }
};

/**
 * Middleware to validate that the authenticated user owns the resource
 * Compares userId from token with userId in request params or body
 */
export const validateOwnership = (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      throw new AuthenticationError('Authentication required');
    }

    // Get userId from params or body
    const resourceUserId = req.params.userId || req.params.id || req.body.userId;

    if (!resourceUserId) {
      // If no userId in request, skip validation (e.g., list endpoints)
      return next();
    }

    // Check if authenticated user owns the resource
    if (req.user.userId !== resourceUserId) {
      throw new AuthorizationError('You do not have permission to access this resource');
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Combined middleware for authentication + ownership validation
 * Use this for routes that require both auth and ownership check
 */
export const authenticateAndValidateOwnership = [
  authenticateToken,
  validateOwnership
];

/**
 * Optional authentication middleware
 * Attaches user if token is present, but doesn't require it
 */
export const optionalAuthentication = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      // No token present, continue without user
      return next();
    }

    const authService = container.get<AuthService>('authService');
    const decoded = authService.verifyAccessToken(token);
    req.user = decoded;

    next();
  } catch (error) {
    // Token present but invalid - continue without user
    next();
  }
};

