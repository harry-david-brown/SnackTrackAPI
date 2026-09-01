import { AppError, DatabaseError } from '../../core/errors';
import {
  DatabaseOptimizationStatus,
  MonitoringQueryRepository,
  QueryPerformanceResult,
} from './MonitoringQueryRepository';

/** Application operations exposed by sensitive monitoring routes. */
export class MonitoringService {
  constructor(private readonly queries: MonitoringQueryRepository) {}

  async getDatabaseOptimizationStatus(): Promise<DatabaseOptimizationStatus> {
    try {
      return await this.queries.getDatabaseOptimizationStatus();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseError('Failed to fetch database optimization status', error);
    }
  }

  async getQueryPerformance(userId?: string): Promise<QueryPerformanceResult> {
    try {
      return await this.queries.getQueryPerformance(userId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseError('Failed to inspect query performance', error);
    }
  }
}
