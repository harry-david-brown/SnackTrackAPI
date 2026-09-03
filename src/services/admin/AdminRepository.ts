import { ConflictError, DatabaseError, NotFoundError, ValidationError } from '../../core/errors';
import type {
  DatabaseQueryExecutor,
  DatabaseRow,
  DatabaseTransactionRunner,
} from '../ports/DatabasePort';
import type { AdminIdentity, AdminRole, AdminStatus } from './AdminTypes';
import { isAdminRole } from './AdminTypes';

interface AdminRow extends DatabaseRow {
  id: unknown;
  email: unknown;
  password_hash?: unknown;
  role: unknown;
  status: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_login_at?: unknown;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new DatabaseError(`Invalid admin field: ${field}`);
  return value;
};
const nullableIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new DatabaseError('Invalid admin timestamp');
  return date.toISOString();
};
const role = (value: unknown): AdminRole => {
  if (!isAdminRole(value)) throw new DatabaseError('Invalid admin role');
  return value;
};
const status = (value: unknown): AdminStatus => {
  if (value === 'active' || value === 'disabled') return value;
  throw new DatabaseError('Invalid admin status');
};
const identity = (row: AdminRow): AdminIdentity => ({
  id: text(row.id, 'id'),
  email: text(row.email, 'email'),
  role: role(row.role),
  status: status(row.status),
});

export interface AdminAccountView extends AdminIdentity {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

export class AdminRepository {
  constructor(
    private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner,
  ) {}

  async findByEmailWithPassword(email: string): Promise<(AdminIdentity & { passwordHash: string }) | null> {
    const result = await this.database.query<AdminRow>(
      'SELECT id, email, password_hash, role, status FROM admin_users WHERE email = $1',
      [email],
    );
    const row = result.rows[0];
    return row ? { ...identity(row), passwordHash: text(row.password_hash, 'password_hash') } : null;
  }

  async bootstrapOwner(email: string, passwordHash: string): Promise<AdminIdentity> {
    return this.database.withTransaction(async (transaction) => {
      const existing = await transaction.query<{ count: unknown } & DatabaseRow>('SELECT COUNT(*)::int AS count FROM admin_users');
      if (Number(existing.rows[0]?.count) > 0) throw new DatabaseError('Administrator accounts already exist; use an owner invitation');
      const result = await transaction.query<AdminRow>(
        `INSERT INTO admin_users (email, password_hash, role)
         VALUES ($1, $2, 'owner') RETURNING id, email, role, status`, [email, passwordHash],
      );
      return identity(result.rows[0]);
    });
  }

  async createSession(adminId: string, tokenHash: string, csrfHash: string, expiresAt: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO admin_sessions (admin_user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [adminId, tokenHash, csrfHash, expiresAt],
    );
    await this.database.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [adminId]);
  }

  async findActiveSession(tokenHash: string): Promise<(AdminIdentity & { csrfHash: string }) | null> {
    const result = await this.database.query<AdminRow & { csrf_hash: unknown }>(
      `SELECT a.id, a.email, a.role, a.status, s.csrf_hash
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
         AND a.status = 'active'`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.database.query(
      'UPDATE admin_sessions SET last_seen_at = NOW() WHERE token_hash = $1',
      [tokenHash],
    );
    return { ...identity(row), csrfHash: text(row.csrf_hash, 'csrf_hash') };
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.database.query(
      'UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE token_hash = $1',
      [tokenHash],
    );
  }

  async createInvitation(input: {
    email: string; role: AdminRole; tokenHash: string; invitedBy: string; expiresAt: Date;
  }): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        'UPDATE admin_invitations SET expires_at = NOW() WHERE email = $1 AND accepted_at IS NULL',
        [input.email],
      );
      await transaction.query(
        `INSERT INTO admin_invitations (email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt],
      );
    });
  }

  async acceptInvitation(tokenHash: string, passwordHash: string): Promise<AdminIdentity> {
    return this.database.withTransaction(async (transaction) => {
      const invitation = await transaction.query<AdminRow & { invitation_id: unknown }>(
        `SELECT id AS invitation_id, email, role, 'active' AS status
         FROM admin_invitations
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW() FOR UPDATE`,
        [tokenHash],
      );
      const row = invitation.rows[0];
      if (!row) throw new NotFoundError('Active administrator invitation');
      const email = text(row.email, 'email');
      const invitedRole = role(row.role);
      const created = await transaction.query<AdminRow>(
        `INSERT INTO admin_users (email, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role, status = 'active', updated_at = NOW()
         RETURNING id, email, role, status`,
        [email, passwordHash, invitedRole],
      );
      await transaction.query('UPDATE admin_invitations SET accepted_at = NOW() WHERE token_hash = $1', [tokenHash]);
      return identity(created.rows[0]);
    });
  }

  async createPasswordReset(adminId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        'UPDATE admin_password_reset_tokens SET used_at = NOW() WHERE admin_user_id = $1 AND used_at IS NULL',
        [adminId],
      );
      await transaction.query(
        `INSERT INTO admin_password_reset_tokens (admin_user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [adminId, tokenHash, expiresAt],
      );
    });
  }

  async resetPassword(tokenHash: string, passwordHash: string): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<{ admin_user_id: unknown } & DatabaseRow>(
        `SELECT admin_user_id FROM admin_password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('Active administrator password reset');
      const adminId = text(row.admin_user_id, 'admin_user_id');
      await transaction.query('UPDATE admin_users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [adminId, passwordHash]);
      await transaction.query('UPDATE admin_password_reset_tokens SET used_at = NOW() WHERE token_hash = $1', [tokenHash]);
      await transaction.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = $1 AND revoked_at IS NULL', [adminId]);
    });
  }

  async listAdministrators(): Promise<AdminAccountView[]> {
    const result = await this.database.query<AdminRow>(
      `SELECT id, email, role, status, created_at, updated_at, last_login_at
       FROM admin_users ORDER BY created_at`,
    );
    return result.rows.map((row) => ({
      ...identity(row),
      createdAt: nullableIso(row.created_at)!,
      updatedAt: nullableIso(row.updated_at)!,
      lastLoginAt: nullableIso(row.last_login_at),
    }));
  }

  async updateAdministrator(actorId: string, targetId: string, next: { role?: AdminRole; status?: AdminStatus }): Promise<AdminIdentity> {
    return this.database.withTransaction(async (transaction) => {
      const targetResult = await transaction.query<AdminRow>(
        'SELECT id, email, role, status FROM admin_users WHERE id = $1 FOR UPDATE',
        [targetId],
      );
      const target = targetResult.rows[0];
      if (!target) throw new NotFoundError('Administrator', targetId);
      const current = identity(target);
      const removesOwner = current.role === 'owner' && (next.role !== undefined && next.role !== 'owner' || next.status === 'disabled');
      if (removesOwner) {
        const owners = await transaction.query<{ count: unknown } & DatabaseRow>(
          `SELECT COUNT(*)::int AS count FROM admin_users
           WHERE role = 'owner' AND status = 'active'`,
        );
        if (Number(owners.rows[0]?.count) <= 1) throw new ConflictError('CONFLICT', 'Cannot remove the final active owner');
      }
      if (actorId === targetId && next.status === 'disabled') throw new ValidationError('Administrators cannot disable their own account', 'status');
      const updated = await transaction.query<AdminRow>(
        `UPDATE admin_users SET role = COALESCE($2, role), status = COALESCE($3, status), updated_at = NOW()
         WHERE id = $1 RETURNING id, email, role, status`,
        [targetId, next.role ?? null, next.status ?? null],
      );
      if (next.status === 'disabled') {
        await transaction.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = $1 AND revoked_at IS NULL', [targetId]);
      }
      return identity(updated.rows[0]);
    });
  }

  async appendAudit(input: {
    actorAdminId?: string; action: string; targetType: string; targetId?: string;
    reason?: string; requestId?: string; outcome: 'success' | 'failure'; metadata?: Record<string, unknown>;
  }, executor: DatabaseQueryExecutor = this.database): Promise<void> {
    await executor.query(
      `INSERT INTO admin_audit_events
       (actor_admin_id, action, target_type, target_id, reason, request_id, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)`,
      [input.actorAdminId ?? null, input.action, input.targetType, input.targetId ?? null,
       input.reason ?? null, input.requestId ?? null, input.outcome, JSON.stringify(input.metadata ?? {})],
    );
  }

  async findAdminByEmail(email: string): Promise<AdminIdentity | null> {
    const result = await this.database.query<AdminRow>(
      'SELECT id, email, role, status FROM admin_users WHERE email = $1', [email],
    );
    return result.rows[0] ? identity(result.rows[0]) : null;
  }
}
