import type { Migration } from './Migration';

/** A refund can be confirmed even when its original order balance is unavailable. */
export const unclassifiedRefundsMigration: Migration = {
  version: 30,
  name: 'unclassified_refunds',
  statements: [
    `ALTER TABLE receipts DROP CONSTRAINT receipt_order_refund_status_check`,
    `ALTER TABLE receipts ADD CONSTRAINT receipt_order_refund_status_check
      CHECK(order_refund_status IS NULL OR order_refund_status IN
        ('none_established','confirmed_unclassified','partial','full','reversed',
         'probable_full','zero_unexplained','conflicted'))`,
  ],
};
