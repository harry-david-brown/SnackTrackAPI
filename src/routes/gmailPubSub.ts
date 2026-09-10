import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import type { GmailPubSubVerifier } from '../services/email/GmailPubSubVerifier';
import type { GmailPushStatePort } from '../services/ports/GmailPushPorts';

interface Dependencies {
  readonly verifier: GmailPubSubVerifier;
  readonly pushes: Pick<GmailPushStatePort, 'recordNotification'>;
  readonly debounceSeconds: number;
  readonly logger: {
    info(message: string, metadata: Readonly<Record<string, unknown>>): void;
    warn(message: string, metadata: Readonly<Record<string, unknown>>): void;
  };
}

export const decodeGmailPubSubNotification = (body: unknown): {
  messageId: string;
  subscription: string;
  emailAddress: string;
  historyId: string;
} | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  if (typeof root.subscription !== 'string' || root.subscription.length > 300) return null;
  if (!root.message || typeof root.message !== 'object' || Array.isArray(root.message)) return null;
  const message = root.message as Record<string, unknown>;
  if (
    typeof message.messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.messageId) ||
    typeof message.data !== 'string' || message.data.length > 1_024 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(message.data)
  ) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(message.data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const payload = decoded as Record<string, unknown>;
  if (Object.keys(payload).some((key) => key !== 'emailAddress' && key !== 'historyId')) return null;
  if (
    typeof payload.emailAddress !== 'string' || payload.emailAddress.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.emailAddress) ||
    typeof payload.historyId !== 'string' || !/^\d{1,30}$/.test(payload.historyId)
  ) return null;
  return {
    messageId: message.messageId,
    subscription: root.subscription,
    emailAddress: payload.emailAddress.trim().toLowerCase(),
    historyId: payload.historyId,
  };
};

export const createGmailPubSubRouter = (dependencies: Dependencies): Router => {
  const router = Router();
  router.post('/', asyncHandler(async (request: Request, response: Response) => {
    await dependencies.verifier.verify(request.header('authorization'));
    const notification = decodeGmailPubSubNotification(request.body as unknown);
    if (!notification || notification.subscription !== dependencies.verifier.expectedSubscription()) {
      dependencies.logger.warn('Authenticated Gmail push payload was rejected', {
        operation: 'gmail_push_receive', outcome: 'invalid_payload',
      });
      response.status(204).end();
      return;
    }
    const result = await dependencies.pushes.recordNotification({
      ...notification,
      debounceSeconds: dependencies.debounceSeconds,
    });
    dependencies.logger.info('Gmail push notification recorded', {
      operation: 'gmail_push_receive', outcome: result.outcome,
      ...(result.outcome === 'accepted' ? { userId: result.userId } : {}),
    });
    response.status(204).end();
  }));
  return router;
};
