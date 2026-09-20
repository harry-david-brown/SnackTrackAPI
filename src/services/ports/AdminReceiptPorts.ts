import type { AdminReceiptReport } from '../admin/AdminReceiptSummary';

export interface AdminReceiptReadPort {
  getReceiptReport(userId: string): Promise<AdminReceiptReport>;
}
