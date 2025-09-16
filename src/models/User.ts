import { AccountType } from './AccountType';

export interface User {
  id: string;
  email: string;
  type: AccountType;
} 