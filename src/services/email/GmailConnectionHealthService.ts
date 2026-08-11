import { User } from '../../models/User';
import { PostgresService } from '../data/PostgresService';
import { UserRepository } from '../data/UserRepository';
import { ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { isGmailReconnectError } from '../import/GmailImportService';
import { GmailClient } from './GmailClient';

export type GmailConnectionHealth = 'disconnected' | 'valid' | 'reconnect_required' | 'unavailable';

export interface GmailConnectionHealthResult {
  status: GmailConnectionHealth;
  validatedAt: string | null;
}

const VALIDATION_TTL_MS = 15 * 60 * 1000;

/** Validates stored Gmail credentials while avoiding a Google request on every screen refresh. */
export class GmailConnectionHealthService {
  private gmail = new GmailClient();
  private users: UserRepository;
  private preferences: ImportPreferencesRepository;
  private successfulValidations = new Map<string, number>();

  constructor(postgres: PostgresService) {
    this.users = new UserRepository(postgres);
    this.preferences = new ImportPreferencesRepository(postgres);
  }

  invalidate(userId: string): void {
    this.successfulValidations.delete(userId);
  }

  async validate(user: User, force = false): Promise<GmailConnectionHealthResult> {
    if (!user.gmailConnected) return { status: 'disconnected', validatedAt: null };
    if (!user.gmailRefreshToken && !user.gmailAccessToken) {
      return { status: 'reconnect_required', validatedAt: null };
    }

    const cachedAt = this.successfulValidations.get(user.id);
    if (!force && cachedAt && Date.now() - cachedAt < VALIDATION_TTL_MS) {
      return { status: 'valid', validatedAt: new Date(cachedAt).toISOString() };
    }

    try {
      await this.gmail.validateConnection(user);
      const validatedAt = Date.now();
      this.successfulValidations.set(user.id, validatedAt);
      return { status: 'valid', validatedAt: new Date(validatedAt).toISOString() };
    } catch (error) {
      this.invalidate(user.id);
      if (isGmailReconnectError(error)) {
        await this.users.markGmailReconnectRequired(user.id);
        await this.preferences.markTrackingReconnectRequired(user.id);
        return { status: 'reconnect_required', validatedAt: null };
      }
      return { status: 'unavailable', validatedAt: null };
    }
  }
}
