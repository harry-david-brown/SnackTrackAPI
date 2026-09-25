import type { DatabaseQueryExecutor } from './DatabasePort';

export type AuthorizationMailboxProvider = 'gmail' | 'outlook';
export interface MailboxAuthorizationClaim {
  readonly stateHash: string;
  readonly userId: string;
  readonly sessionVersion: number;
  readonly importGeneration: string;
  readonly state: string;
  readonly code: string;
}

export interface MailboxAuthorizationPort {
  register(userId: string, provider: AuthorizationMailboxProvider, authUrl: string,
    verifierHash: string, sessionVersion: number): Promise<void>;
  receive(provider: AuthorizationMailboxProvider, state: string, code?: string): Promise<string>;
  cancel(userId: string, provider: AuthorizationMailboxProvider): Promise<void>;
  consume(userId: string, provider: AuthorizationMailboxProvider, completionToken: string,
    verifier: string): Promise<MailboxAuthorizationClaim>;
  persist(claim: MailboxAuthorizationClaim,
    write: (transaction: DatabaseQueryExecutor) => Promise<void>): Promise<void>;
}
