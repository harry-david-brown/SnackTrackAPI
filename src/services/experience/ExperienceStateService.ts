import { ValidationError } from '../../core/errors';
import type { ExperienceStateRepository } from '../data/ExperienceStateRepository';
import {
  FIRST_RECAP_VERSION,
  type ExperienceState,
} from './ExperienceStateTypes';

export class ExperienceStateService {
  constructor(private readonly states: Pick<ExperienceStateRepository, 'get' | 'markFirstRecapSeen'>) {}

  get(userId: string): Promise<ExperienceState> {
    return this.states.get(userId);
  }

  markFirstRecapSeen(userId: string, version: string): Promise<ExperienceState> {
    if (version !== FIRST_RECAP_VERSION) {
      throw new ValidationError('Unsupported recap version.', 'version');
    }
    return this.states.markFirstRecapSeen(userId, version);
  }
}
