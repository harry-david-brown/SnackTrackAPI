import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { AuthenticationError, ValidationError } from '../../core/errors';
import type { AdminIdentity, AdminRole, AdminStatus } from './AdminTypes';
import type { AdminRepository } from './AdminRepository';

export interface AdminMailPort {
  sendAdminInvitation(email: string, link: string): Promise<void>;
  sendAdminPasswordReset(email: string, link: string): Promise<void>;
}

export interface AdminAuthOptions {
  readonly dashboardUrl: string;
  readonly sessionHours?: number;
  readonly now?: () => Date;
}

export interface CreatedAdminSession {
  readonly admin: AdminIdentity;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');

const validatePassword = (password: string): void => {
  if (password.length < 12 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError(
      'Must be 12–128 characters and include uppercase, lowercase, and a number',
      'password',
    );
  }
};

export class AdminAuthService {
  private readonly now: () => Date;
  private readonly sessionHours: number;

  constructor(
    private readonly repository: AdminRepository,
    private readonly mail: AdminMailPort,
    private readonly options: AdminAuthOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.sessionHours = options.sessionHours ?? 8;
  }

  async login(email: string, password: string): Promise<CreatedAdminSession> {
    const account = await this.repository.findByEmailWithPassword(normalizeEmail(email));
    if (!account || account.status !== 'active' || !(await bcrypt.compare(password, account.passwordHash))) {
      throw new AuthenticationError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    return this.createSession(account);
  }

  async authenticate(sessionToken: string): Promise<AdminIdentity & { csrfHash: string }> {
    const session = await this.repository.findActiveSession(hashToken(sessionToken));
    if (!session) throw new AuthenticationError('Administrator session is invalid or expired');
    return session;
  }

  async logout(sessionToken: string): Promise<void> {
    await this.repository.revokeSession(hashToken(sessionToken));
  }

  verifyCsrf(expectedHash: string, suppliedToken: string): void {
    if (!suppliedToken || hashToken(suppliedToken) !== expectedHash) {
      throw new AuthenticationError('Invalid CSRF token');
    }
  }

  async invite(actor: AdminIdentity, email: string, role: AdminRole): Promise<{ email: string; role: AdminRole; expiresAt: string }> {
    const normalizedEmail = normalizeEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new ValidationError('Invalid email', 'email');
    const invitationToken = token();
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000);
    await this.repository.createInvitation({
      email: normalizedEmail,
      role,
      tokenHash: hashToken(invitationToken),
      invitedBy: actor.id,
      expiresAt,
    });
    await this.repository.appendAudit({
      actorAdminId: actor.id,
      action: 'administrator.invite',
      targetType: 'administrator_invitation',
      targetId: normalizedEmail,
      outcome: 'success',
      metadata: { role },
    });
    await this.mail.sendAdminInvitation(
      normalizedEmail,
      `${this.options.dashboardUrl}/accept-invite?token=${encodeURIComponent(invitationToken)}`,
    );
    return { email: normalizedEmail, role, expiresAt: expiresAt.toISOString() };
  }

  async acceptInvitation(invitationToken: string, password: string): Promise<CreatedAdminSession> {
    validatePassword(password);
    const admin = await this.repository.acceptInvitation(hashToken(invitationToken), () => bcrypt.hash(password, 12));
    return this.createSession(admin);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const admin = await this.repository.findAdminByEmail(normalizedEmail);
    if (!admin || admin.status !== 'active') return;
    const resetToken = token();
    const expiresAt = new Date(this.now().getTime() + 30 * 60 * 1000);
    await this.repository.createPasswordReset(admin.id, hashToken(resetToken), expiresAt);
    await this.mail.sendAdminPasswordReset(
      normalizedEmail,
      `${this.options.dashboardUrl}/reset-password?token=${encodeURIComponent(resetToken)}`,
    );
  }

  async resetPassword(resetToken: string, password: string): Promise<void> {
    validatePassword(password);
    await this.repository.resetPassword(hashToken(resetToken), () => bcrypt.hash(password, 12));
  }

  listAdministrators() {
    return this.repository.listAdministrators();
  }

  updateAdministrator(actorId: string, targetId: string, next: { role?: AdminRole; status?: AdminStatus }) {
    return this.repository.updateAdministrator(actorId, targetId, next).then(async (updated) => {
      await this.repository.appendAudit({
        actorAdminId: actorId,
        action: 'administrator.update',
        targetType: 'administrator',
        targetId,
        outcome: 'success',
        metadata: next,
      });
      return updated;
    });
  }

  private async createSession(admin: AdminIdentity): Promise<CreatedAdminSession> {
    const sessionToken = token();
    const csrfToken = token();
    const expiresAt = new Date(this.now().getTime() + this.sessionHours * 60 * 60 * 1000);
    await this.repository.createSession(admin.id, hashToken(sessionToken), hashToken(csrfToken), expiresAt);
    return { admin, sessionToken, csrfToken, expiresAt: expiresAt.toISOString() };
  }
}
