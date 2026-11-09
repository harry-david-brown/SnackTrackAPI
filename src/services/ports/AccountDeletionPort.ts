export interface AccountDeletionRequestPort {
  request(userId: string): Promise<void>;
  due(limit: number): Promise<string[]>;
  defer(userId: string, errorCode: string): Promise<void>;
}
