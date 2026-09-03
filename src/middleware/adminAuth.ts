import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthenticationError, AuthorizationError } from '../core/errors';
import type { AdminIdentity, AdminRole } from '../services/admin/AdminTypes';
import { roleAllows } from '../services/admin/AdminTypes';
import type { AdminAuthService } from '../services/admin/AdminAuthService';

declare global {
  namespace Express {
    interface Request { admin?: AdminIdentity & { csrfHash: string }; adminSessionToken?: string; }
  }
}

export const ADMIN_SESSION_COOKIE = 'snacktrack_admin_session';
export const ADMIN_CSRF_COOKIE = 'snacktrack_admin_csrf';

const cookie = (request: Request, name: string): string | undefined => {
  const header = request.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
};

export const requireAdminOrigin = (allowedOrigin: string): RequestHandler =>
  (request, _response, next) => {
    const origin = request.get('origin');
    if (origin !== allowedOrigin) return next(new AuthorizationError('Untrusted administrator origin'));
    next();
  };

export const createAuthenticateAdmin = (auth: Pick<AdminAuthService, 'authenticate'>): RequestHandler =>
  async (request, _response, next) => {
    try {
      const sessionToken = cookie(request, ADMIN_SESSION_COOKIE);
      if (!sessionToken) throw new AuthenticationError('Administrator authentication required');
      request.admin = await auth.authenticate(sessionToken);
      request.adminSessionToken = sessionToken;
      next();
    } catch (error) { next(error); }
  };

export const createRequireAdminRole = (required: AdminRole): RequestHandler =>
  (request: Request, _response: Response, next: NextFunction) => {
    if (!request.admin) return next(new AuthenticationError('Administrator authentication required'));
    if (!roleAllows(request.admin.role, required)) return next(new AuthorizationError());
    next();
  };

export const createRequireAdminCsrf = (auth: Pick<AdminAuthService, 'verifyCsrf'>): RequestHandler =>
  (request, _response, next) => {
    try {
      if (!request.admin) throw new AuthenticationError('Administrator authentication required');
      const header = request.get('X-CSRF-Token');
      const cookieToken = cookie(request, ADMIN_CSRF_COOKIE);
      if (!header || header !== cookieToken) throw new AuthenticationError('Invalid CSRF token');
      auth.verifyCsrf(request.admin.csrfHash, header);
      next();
    } catch (error) { next(error); }
  };
