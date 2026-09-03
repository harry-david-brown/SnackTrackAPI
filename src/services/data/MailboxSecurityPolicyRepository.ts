import { NotFoundError, ValidationError } from '../../core/errors';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';

export interface MailboxSecurityPolicy {
  readonly allowForwardedReceipts: boolean;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export class MailboxSecurityPolicyRepository {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async get(userId: string): Promise<MailboxSecurityPolicy> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT allow_forwarded_receipts,reason,updated_at
       FROM user_mailbox_security_policies WHERE user_id=$1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? {
      allowForwardedReceipts: row.allow_forwarded_receipts === true,
      reason: typeof row.reason === 'string' ? row.reason : null,
      updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
    } : { allowForwardedReceipts: false, reason: null, updatedAt: null };
  }

  async set(input: {
    userId: string;
    allowForwardedReceipts: boolean;
    reason: string;
    actorAdminId: string;
    requestId?: string;
  }): Promise<MailboxSecurityPolicy> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) throw new ValidationError('Must be 10–500 characters', 'reason');
    await this.database.withTransaction(async (transaction) => {
      const user = await transaction.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [input.userId]);
      if (!user.rows[0]) throw new NotFoundError('User', input.userId);
      await transaction.query(
        `INSERT INTO user_mailbox_security_policies
         (user_id,allow_forwarded_receipts,reason,updated_by_admin_id,updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           allow_forwarded_receipts=EXCLUDED.allow_forwarded_receipts,
           reason=EXCLUDED.reason,updated_by_admin_id=EXCLUDED.updated_by_admin_id,updated_at=NOW()`,
        [input.userId, input.allowForwardedReceipts, reason, input.actorAdminId],
      );
      await transaction.query(
        `INSERT INTO admin_audit_events
         (actor_admin_id,action,target_type,target_id,reason,request_id,outcome,metadata)
         VALUES ($1,$2,'user',$3,$4,$5,'success',$6::jsonb)`,
        [input.actorAdminId, input.allowForwardedReceipts ? 'mailbox.forwarding_exception_enabled' : 'mailbox.forwarding_exception_revoked', input.userId, reason, input.requestId ?? null, JSON.stringify({ allowForwardedReceipts: input.allowForwardedReceipts })],
      );
    });
    return this.get(input.userId);
  }
}
