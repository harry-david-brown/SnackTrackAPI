import type { MailboxConnectionRepository } from '../data/MailboxConnectionRepository';
import type { MicrosoftGraphMailboxClient } from './MicrosoftGraphMailboxClient';

export class OutlookExportReadyDetector {
  constructor(
    private readonly connections: Pick<MailboxConnectionRepository, 'findMicrosoft'>,
    private readonly graph: Pick<MicrosoftGraphMailboxClient, 'hasUberExportReadyEmail'|'hasExportReadyEmail'>,
  ) {}

  async hasExportReadyEmail(userId: string, requestedAt: string, provider: 'uber_eats'|'doordash'): Promise<boolean> {
    const connection=await this.connections.findMicrosoft(userId);
    if (!connection || connection.state!=='connected') return false;
    return this.graph.hasExportReadyEmail(connection,requestedAt,provider);
  }

  async hasUberExportReadyEmail(userId: string, requestedAt: string): Promise<boolean> {
    const connection = await this.connections.findMicrosoft(userId);
    if (!connection || connection.state !== 'connected') return false;
    return this.graph.hasUberExportReadyEmail(connection, requestedAt);
  }
}
