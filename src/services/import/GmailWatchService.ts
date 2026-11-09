import type { ImportPreferencesQueryPort, MailboxUserPort } from '../ports/ImportPorts';
import type { GmailPushStatePort, GmailWatchClientPort } from '../ports/GmailPushPorts';

export class GmailWatchService {
  constructor(
    private readonly users: Pick<MailboxUserPort, 'findByIdWithGmailTokens'>,
    private readonly preferences: Pick<ImportPreferencesQueryPort, 'get'|'getProviderExports'>,
    private readonly gmail: GmailWatchClientPort,
    private readonly pushes: Pick<GmailPushStatePort, 'hasHealthyWatch'|'saveWatch'|'recordWatchFailure'|'clearWatch'|'listWatchCandidates'>,
    private readonly topicName: string | undefined,
    private readonly logger: { warn(message: string, metadata: Readonly<Record<string, unknown>>): void },
  ) {}

  async ensureForUser(userId: string, force = false): Promise<boolean> {
    if (!this.topicName) return false;
    const [user, preferences, exports] = await Promise.all([
      this.users.findByIdWithGmailTokens(userId),
      this.preferences.get(userId),
      this.preferences.getProviderExports(userId),
    ]);
    const exportAlertActive = Object.values(exports).some(p=>p.status==='requested' && p.readyAlert?.consentState==='granted');
    if (
      user?.deletionRequested || !user?.gmailConnected || user.gmailConnectionMode !== 'offline' || !user.gmailRefreshToken ||
      (!exportAlertActive && preferences.ongoingTrackingConsentState !== 'granted')
    ) return false;
    if (!force && await this.pushes.hasHealthyWatch(userId)) return true;
    try {
      const watch = await this.gmail.startMailboxWatch(user, this.topicName);
      await this.pushes.saveWatch(userId, watch.historyId, watch.expiration);
      return true;
    } catch (error) {
      const errorCode = typeof (error as { code?: unknown })?.code === 'string'
        ? String((error as { code: string }).code)
        : 'GMAIL_WATCH_FAILED';
      await this.pushes.recordWatchFailure(
        userId,
        errorCode,
      );
      this.logger.warn('Gmail watch setup failed', {
        operation: 'gmail_watch_ensure', userId, outcome: 'failure', errorCode,
      });
      throw error;
    }
  }

  async stopForUser(userId: string): Promise<void> {
    const user = await this.users.findByIdWithGmailTokens(userId);
    if (user?.gmailConnected && (user.gmailRefreshToken || user.gmailAccessToken)) {
      await this.gmail.stopMailboxWatch(user).catch((error) => {
        this.logger.warn('Gmail watch stop failed', {
          operation: 'gmail_watch_stop', userId, outcome: 'failure', error,
        });
      });
    }
    await this.pushes.clearWatch(userId);
  }

  async renewDue(limit = 5_000): Promise<{ attempted: number; renewed: number; failed: number }> {
    if (!this.topicName) return { attempted: 0, renewed: 0, failed: 0 };
    const candidates = await this.pushes.listWatchCandidates(limit);
    let renewed = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        if (await this.ensureForUser(candidate.userId, true)) renewed += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted: candidates.length, renewed, failed };
  }
}
