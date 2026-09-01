import { AppError, DatabaseError, ValidationError } from '../../core/errors';
import {
  AdministratorQueryRepository,
  AdministratorUserSummary,
  DatabaseStatistics,
} from './AdministratorQueryRepository';

export interface AdministratorUserPageResult {
  readonly users: readonly AdministratorUserSummary[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
  };
}

export interface DatabaseStatisticsResult extends DatabaseStatistics {
  readonly health: {
    readonly status: 'HEALTHY';
    readonly timestamp: string;
  };
}

/** Application operations exposed by administrator database routes. */
export class AdministratorService {
  constructor(
    private readonly queries: AdministratorQueryRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listUsers(limit: number, offset: number): Promise<AdministratorUserPageResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError('Must be an integer between 1 and 1000', 'limit');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError('Must be a non-negative integer', 'offset');
    }

    try {
      const result = await this.queries.listUsers(limit, offset);
      return {
        users: result.users,
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: offset + result.users.length < result.total,
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseError('Failed to fetch users', error);
    }
  }

  async getDatabaseStatistics(): Promise<DatabaseStatisticsResult> {
    try {
      const result = await this.queries.getDatabaseStatistics();
      return {
        ...result,
        health: {
          status: 'HEALTHY',
          timestamp: this.now().toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseError('Failed to fetch database statistics', error);
    }
  }
}
