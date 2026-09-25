import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, AuthenticationError, AuthorizationError } from '../core/errors';
import { TokenPayload } from '../models/Token';
import { TokenService } from '../services/auth/TokenService';
import { StructuredLogger } from '../services/core/StructuredLogger';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

interface AuthenticationObservability {
  setUserContext(userId: string, email: string): void;
}

export interface AuthenticationMiddlewareDependencies {
  readonly tokens: Pick<TokenService, 'verifyAccessToken'>;
  readonly sessions: { verifyAccessSession(payload: TokenPayload): Promise<void> };
  readonly observability: AuthenticationObservability;
  readonly logger: StructuredLogger;
}

const bearerToken = (req: Request): string | undefined => {
  const header = req.get('Authorization');
  if (!header) return undefined;
  if (!header.startsWith('Bearer ')) {
    throw new AuthenticationError('Authorization header must use Bearer authentication');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new AuthenticationError('Access token is required');
  return token;
};

export const createAuthenticateToken = (
  dependencies: AuthenticationMiddlewareDependencies,
): RequestHandler => {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req);
      if (!token) throw new AuthenticationError('Access token is required');
      const payload = dependencies.tokens.verifyAccessToken(token);
      await dependencies.sessions.verifyAccessSession(payload);
      req.user = payload;
      dependencies.observability.setUserContext(payload.userId, payload.email);
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AuthenticationError('Access token is invalid', 'ACCESS_TOKEN_INVALID'),
      );
    }
  };
};

export type InvalidOptionalCredentialPolicy = 'reject' | 'continue_anonymous';

/**
 * Optional authentication is anonymous only when no credential is presented.
 * Callers must explicitly choose whether an invalid presented credential is rejected.
 */
export const createOptionalAuthentication = (
  dependencies: AuthenticationMiddlewareDependencies,
  invalidCredentialPolicy: InvalidOptionalCredentialPolicy = 'reject',
): RequestHandler => {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req);
      if (!token) return next();
      const payload = dependencies.tokens.verifyAccessToken(token);
      await dependencies.sessions.verifyAccessSession(payload);
      req.user = payload;
      dependencies.observability.setUserContext(payload.userId, payload.email);
      return next();
    } catch (error) {
      const known = error instanceof AuthenticationError;
      dependencies.logger.warn('Optional authentication credential could not be verified', {
        requestId: req.requestId,
        operation: 'optional_authentication',
        outcome: invalidCredentialPolicy === 'reject' ? 'rejected' : 'continued_anonymous',
        errorCode: known ? error.code : 'INTERNAL_ERROR',
      });
      if (invalidCredentialPolicy === 'continue_anonymous' && known) return next();
      return next(
        error instanceof AppError ? error : new AuthenticationError('Access token is invalid', 'ACCESS_TOKEN_INVALID'),
      );
    }
  };
};

export const validateOwnership = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    if (!req.user) throw new AuthenticationError('Authentication required');
    const body: unknown = req.body;
    const bodyUserId =
      typeof body === 'object' &&
      body !== null &&
      'userId' in body &&
      typeof body.userId === 'string'
        ? body.userId
        : undefined;
    const resourceUserId = req.params.userId || req.params.id || bodyUserId;
    if (resourceUserId && req.user.userId !== resourceUserId) {
      throw new AuthorizationError('You do not have permission to access this resource');
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const createAuthenticateAndValidateOwnership = (
  dependencies: AuthenticationMiddlewareDependencies,
): readonly RequestHandler[] => [createAuthenticateToken(dependencies), validateOwnership];
