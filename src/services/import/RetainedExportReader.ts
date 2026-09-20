import { createHash } from 'crypto';
import { constants, createWriteStream } from 'fs';
import { mkdtemp, open, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { AppError } from '../../core/errors';
import type { RetainedReceiptSourceReadPort } from '../ports/ReceiptRepairAcquisitionPorts';
import { CsvImportService } from './CsvImportService';
import { ZipExtractor, type ExtractedTemporaryFile } from './ZipExtractor';
import { CSV_EXPORT_LIMIT_BYTES, ZIP_EXPORT_LIMIT_BYTES } from './ExportFileLimits';

/** Parses a private byte-for-byte snapshot so file replacement cannot race hashing and parsing. */
export class RetainedExportReader implements RetainedReceiptSourceReadPort {
  constructor(
    private readonly csv: Pick<
      CsvImportService,
      'validateCsvPathForProvider' | 'parseCsvPathForProvider'
    >,
    private readonly zip: Pick<ZipExtractor, 'isZipFile' | 'extractProviderCSVToFile'>,
  ) {}

  async read(input: Parameters<RetainedReceiptSourceReadPort['read']>[0]) {
    if (input.sourceKind !== 'provider_export') throw new AppError({code:'INVALID_REPAIR_ACQUISITION', message:'The export reader requires export evidence'});
    const directory = await mkdtemp(join(tmpdir(), 'snacktrack-repair-export-'));
    const snapshot = join(directory, 'source');
    let extracted: ExtractedTemporaryFile | undefined;
    try {
      const source = await open(
        input.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const hash = createHash('sha256');
      let sizeBytes = 0;
      try {
        const before = await source.stat();
        if (!before.isFile() || before.size <= 0 || before.size > ZIP_EXPORT_LIMIT_BYTES)
          throw new AppError({
            code: 'INVALID_RETAINED_EXPORT',
            message: 'A nonempty regular export file within the upload size limit is required',
          });
        await pipeline(
          source.createReadStream({ autoClose: false }),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              sizeBytes += chunk.length;
              if (sizeBytes > ZIP_EXPORT_LIMIT_BYTES) {
                callback(
                  new AppError({
                    code: 'PAYLOAD_TOO_LARGE',
                    message: 'Retained export exceeds the upload size limit',
                  }),
                );
                return;
              }
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }),
        );
        const after = await source.stat();
        if (
          sizeBytes !== before.size ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new AppError({
            code: 'REPAIR_SOURCE_CHANGED',
            message: 'Retained export changed while being read; preview it again',
          });
      } finally {
        await source.close();
      }
      const artifact = { sha256: hash.digest('hex'), sizeBytes };
      const isZip = await this.zip.isZipFile(snapshot);
      if (!isZip && sizeBytes > CSV_EXPORT_LIMIT_BYTES)
        throw new AppError({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Retained CSV exceeds the upload size limit',
        });
      if (isZip) extracted = await this.zip.extractProviderCSVToFile(snapshot, input.provider);
      const csvPath = extracted?.path ?? snapshot;
      const validation = await this.csv.validateCsvPathForProvider(csvPath, input.provider);
      if (!validation.valid)
        throw new AppError({
          code: 'INVALID_CSV_FORMAT',
          message: 'Retained export does not contain the selected provider order format',
        });
      const parsed = await this.csv.parseCsvPathForProvider(
        csvPath,
        input.provider,
        input.userId,
        input.timezone,
        3,
      );
      const rejectedRecords = parsed.rejectedRecords ?? parsed.errors.length;
      return {
        artifact,
        receipts: parsed.receipts,
        rejectedRecords,
        successfulCompletion: parsed.success && rejectedRecords === 0,
      };
    } finally {
      try {
        await extracted?.remove();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
