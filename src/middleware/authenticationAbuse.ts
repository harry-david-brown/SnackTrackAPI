import type { RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AuthenticationAbuseService, AuthenticationBudget } from '../services/auth/AuthenticationAbuseService';

const login: AuthenticationBudget = { scope: 'login', ipMaximum: 50, accountMaximum: 10, windowSeconds: 900 };
const enroll: AuthenticationBudget = { scope: 'register', ipMaximum: 20, accountMaximum: 5, windowSeconds: 3600 };
const mail: AuthenticationBudget = { scope: 'verification-mail', ipMaximum: 20, accountMaximum: 5, windowSeconds: 3600 };
const verify: AuthenticationBudget = { scope: 'verification', ipMaximum: 50, accountMaximum: 10, windowSeconds: 900 };
const provider: AuthenticationBudget = { scope: 'provider', ipMaximum: 50, accountMaximum: 20, windowSeconds: 900 };

export const authenticationBudget = (path: string): AuthenticationBudget | undefined => {
  const normalized = path.toLowerCase().replace(/\/+$/, '');
  if (['/auth/login', '/admin/v1/auth/login'].includes(normalized)) return login;
  if (normalized === '/auth/register') return enroll;
  if (['/auth/password/reset/request', '/auth/email/verify/send', '/auth/microsoft/email/send', '/admin/v1/auth/forgot-password'].includes(normalized)) return mail;
  if (['/auth/password/reset/verify', '/auth/password/reset/complete', '/auth/email/verify/confirm', '/auth/microsoft/email/confirm', '/admin/v1/auth/reset-password'].includes(normalized)) return verify;
  if (/^\/admin\/v1\/invitations\/[^/]+\/accept$/.test(normalized)) return { ...verify, scope: 'admin-invitation', ipMaximum: 20, accountMaximum: 5 };
  if (['/auth/google', '/auth/apple', '/auth/microsoft', '/auth/microsoft/attempt'].includes(normalized)) return provider;
  return undefined;
};

export const createAuthenticationAbuseMiddleware = (service: Pick<AuthenticationAbuseService, 'consume'>): RequestHandler => async (req, res, next) => {
  const budget = req.method === 'POST' ? authenticationBudget(req.path) : undefined;
  if (!budget) { next(); return; }
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body as Record<string, unknown> | undefined;
  for (const field of ['password', 'newPassword']) {
    if (typeof body?.[field] === 'string' && Buffer.byteLength(body[field]) > 1024) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Password is too long.' });
      return;
    }
  }
  const invitation = /\/invitations\/([^/]+)\/accept\/?$/i.exec(req.path)?.[1];
  const account = typeof body?.email === 'string' ? body.email.trim().toLowerCase()
    : invitation ?? (typeof body?.token === 'string' ? body.token : undefined);
  try {
    const retryAfter = await service.consume(budget, ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown'), account);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({ success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts. Please try again later.', retryAfter, retryable: true });
      return;
    }
  } catch {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ success: false, code: 'AUTH_RATE_LIMIT_UNAVAILABLE', message: 'Sign-in is temporarily unavailable. Please try again.', retryAfter: 5, retryable: true });
    return;
  }
  next();
};
