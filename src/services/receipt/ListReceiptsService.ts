import { Receipt } from '../../models/Receipt';
import {
  ReceiptListFilters,
  ReceiptRepository,
} from '../data/ReceiptRepository';

export interface ListReceiptsInput {
  filters: ReceiptListFilters;
  limit: number;
  offset: number;
}

export interface ListReceiptsResult {
  receipts: Receipt[];
  total: number;
}

/** Application operation for one authenticated user's receipt history page. */
export class ListReceiptsService {
  constructor(private readonly receipts: ReceiptRepository) {}

  execute(input: ListReceiptsInput): Promise<ListReceiptsResult> {
    return this.receipts.findPage(input.filters, input.limit, input.offset);
  }
}
