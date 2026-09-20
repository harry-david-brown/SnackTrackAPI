import {runReceiptRepairAcquisition} from './receiptRepairAcquisitionRuntime';
import {parseReceiptRepairSourceOptions} from './receiptRepairSourceOptions';

void runReceiptRepairAcquisition(() => parseReceiptRepairSourceOptions(process.argv.slice(2),'provider_export'));
