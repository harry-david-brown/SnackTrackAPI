import { createHmac } from 'crypto';
import type { AuthAbuseBudgetPort } from '../ports/AuthAbuseBudgetPort';

export interface AuthenticationBudget {
  scope: string;
  ipMaximum: number;
  accountMaximum: number;
  windowSeconds: number;
}

export class AuthenticationAbuseService {
  constructor(private readonly store: AuthAbuseBudgetPort, private readonly keySecret: string) {}

  async consume(budget: AuthenticationBudget, ip: string, account?: string): Promise<number> {
    const key = (type: string, value: string) => `auth-abuse:v1:${budget.scope}:${type}:` +
      createHmac('sha256', this.keySecret).update(value).digest('hex');
    const ipRetry = await this.store.consume(key('ip', ip), budget.ipMaximum, budget.windowSeconds);
    if (ipRetry > 0) return ipRetry;
    return account ? this.store.consume(key('account', account), budget.accountMaximum, budget.windowSeconds) : 0;
  }
}
