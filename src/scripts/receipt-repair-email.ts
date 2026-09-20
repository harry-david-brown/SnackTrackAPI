import {runReceiptRepairAcquisition} from './receiptRepairAcquisitionRuntime';
import {parseReceiptRepairSourceOptions} from './receiptRepairSourceOptions';

void runReceiptRepairAcquisition(() => parseReceiptRepairSourceOptions(process.argv.slice(2),'retained_email'));
