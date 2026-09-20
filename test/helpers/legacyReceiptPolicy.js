// These characterization suites intentionally exercise pre-v3 records/formulas.
// Each Node test file has an isolated process. Set the legacy default before
// loading its owners; explicit v3 projections still use the v3 metric policy.
// Serving-default behavior is covered without this helper in activation and
// durable import integration tests.
require('../../dist/services/receipt/ReceiptPolicy').ACTIVE_RECEIPT_POLICY = 2;
