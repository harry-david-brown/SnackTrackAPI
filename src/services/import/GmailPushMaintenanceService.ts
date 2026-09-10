import type { GmailPushDispatchService } from './GmailPushDispatchService';
import type { GmailWatchService } from './GmailWatchService';

/** Scheduler-facing replacement for broad Gmail polling. */
export class GmailPushMaintenanceService {
  constructor(
    private readonly dispatcher: GmailPushDispatchService,
    private readonly watches: GmailWatchService,
  ) {}

  async run(limit = 500) {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const dispatch = await this.dispatcher.dispatchDue(boundedLimit);
    const watches = await this.watches.renewDue(5_000);
    return { dispatch, watches };
  }
}
