import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import yauzl from 'yauzl';
import { AppError } from '../../core/errors';
import type { ExportProvider } from './ImportJobTypes';

const MAX_ENTRIES = 1_000;
const MAX_TOTAL_DECLARED_BYTES = 250 * 1024 * 1024;
const MAX_CSV_BYTES = 25 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_PATH_BYTES = 512;

export interface ExtractedTemporaryFile {
  readonly path: string;
  readonly filename: string;
  readonly size: number;
  remove(): Promise<void>;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const updateCrc = (current: number, chunk: Buffer): number => {
  let crc = current;
  for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
};

const normalizedHeader = (value: Buffer): string => value.toString('utf8')
  .replace(/^\uFEFF/, '')
  .replace(/\r?\n$/, '')
  .trim();

export class ZipExtractor {
  async extractProviderCSVToFile(filePath: string, provider: ExportProvider): Promise<ExtractedTemporaryFile> {
    const { zipfile, candidates } = await this.scan(filePath, provider);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snacktrack-export-'));
    await fs.promises.chmod(directory, 0o700);
    const targetPath = path.join(directory, 'export.csv');
    const output = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
    let combinedBytes = 0;
    let expectedHeader: string | null = null;
    let lastWrittenByte: number | undefined;
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        // Each file is a complete CSV document. Its last row need not end in a newline;
        // preserve the row boundary when removing the next shard's repeated header.
        if (index > 0 && lastWrittenByte !== 0x0a) {
          combinedBytes += 1;
          if (combinedBytes > MAX_CSV_BYTES) throw this.error('ZIP_OUTPUT_TOO_LARGE', 'The extracted CSV exceeds the safe size limit.');
          if (!output.write('\n')) await once(output, 'drain');
          lastWrittenByte = 0x0a;
        }
        const entry = candidates[index];
        const stream = await this.openEntry(zipfile, entry);
        let actualBytes = 0;
        let crc = 0xffffffff;
        let header = Buffer.alloc(0);
        let headerComplete = false;
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          actualBytes += chunk.length;
          if (actualBytes > entry.uncompressedSize || actualBytes > MAX_CSV_BYTES) {
            throw this.error('ZIP_SIZE_MISMATCH', 'A ZIP entry expanded beyond its declared or allowed size.');
          }
          crc = updateCrc(crc, chunk);
          let writable = chunk;
          if (!headerComplete) {
            header = Buffer.concat([header, chunk]);
            if (header.length > MAX_HEADER_BYTES) throw this.error('CSV_HEADER_TOO_LARGE', 'The CSV header is too large.');
            const newline = header.indexOf(0x0a);
            if (newline < 0) continue;
            const currentHeader = normalizedHeader(header.subarray(0, newline + 1));
            if (!currentHeader || (expectedHeader !== null && currentHeader !== expectedHeader)) {
              throw this.error('INVALID_CSV_FORMAT', 'CSV shards do not have the same header.');
            }
            expectedHeader ??= currentHeader;
            writable = index === 0 ? header : header.subarray(newline + 1);
            headerComplete = true;
            header = Buffer.alloc(0);
          }
          if (writable.length > 0) {
            combinedBytes += writable.length;
            if (combinedBytes > MAX_CSV_BYTES) throw this.error('ZIP_OUTPUT_TOO_LARGE', 'The extracted CSV exceeds the safe size limit.');
            if (!output.write(writable)) await once(output, 'drain');
            lastWrittenByte = writable[writable.length - 1];
          }
        }
        if (!headerComplete || actualBytes !== entry.uncompressedSize) {
          throw this.error('ZIP_SIZE_MISMATCH', 'A ZIP entry ended before its declared size.');
        }
        if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
          throw this.error('ZIP_INTEGRITY_FAILED', 'A ZIP entry failed its integrity check.');
        }
      }
      output.end();
      await once(output, 'finish');
      if (combinedBytes <= 0) throw this.error('NO_VALID_EXPORT_ORDERS', 'The export contains no order data.');
      return {
        path: targetPath,
        filename: provider === 'uber_eats' ? 'user_orders.csv' : 'consumer_order_details.csv',
        size: combinedBytes,
        remove: async () => void (await fs.promises.rm(directory, { recursive: true, force: true })),
      };
    } catch (error) {
      output.destroy();
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      zipfile.close();
    }
  }

  async isZipFile(filePath: string): Promise<boolean> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const signature = Buffer.alloc(4);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      return bytesRead === 4 && signature[0] === 0x50 && signature[1] === 0x4b;
    } finally {
      await handle.close();
    }
  }

  private async scan(filePath: string, provider: ExportProvider): Promise<{ zipfile: yauzl.ZipFile; candidates: yauzl.Entry[] }> {
    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, archive) => {
        if (error || !archive) reject(this.error('ZIP_INVALID', 'The ZIP file is corrupt or unreadable.'));
        else resolve(archive);
      });
    });
    try {
      const entries = await new Promise<yauzl.Entry[]>((resolve, reject) => {
        const selected: yauzl.Entry[] = [];
        let count = 0;
        let totalDeclared = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        zipfile.on('entry', (entry: yauzl.Entry) => {
          try {
            count += 1;
            if (count > MAX_ENTRIES) throw this.error('ZIP_TOO_MANY_ENTRIES', 'The ZIP contains too many files.');
            this.assertSafeEntry(entry);
            if (!entry.fileName.endsWith('/')) {
              totalDeclared += entry.uncompressedSize;
              if (totalDeclared > MAX_TOTAL_DECLARED_BYTES) throw this.error('ZIP_TOO_LARGE', 'The ZIP expands beyond the safe archive limit.');
            }
            if (this.matches(entry.fileName, provider)) selected.push(entry);
            zipfile.readEntry();
          } catch (error) {
            fail(error instanceof Error ? error : new Error('ZIP validation failed'));
          }
        });
        zipfile.once('end', () => {
          if (!settled) {
            settled = true;
            resolve(selected);
          }
        });
        zipfile.once('error', () => fail(this.error('ZIP_INVALID', 'The ZIP file is corrupt or unreadable.')));
        zipfile.readEntry();
      });
      if (provider === 'doordash' && entries.length !== 1) {
        throw this.error(entries.length ? 'ZIP_AMBIGUOUS_EXPORT' : 'NO_VALID_EXPORT_ORDERS', entries.length ? 'The ZIP contains multiple DoorDash order files.' : 'The ZIP does not contain DoorDash order data.');
      }
      if (provider === 'uber_eats') {
        if (!entries.length) throw this.error('NO_VALID_EXPORT_ORDERS', 'The ZIP does not contain Uber Eats order data.');
        const indexes = entries.map((entry) => Number(entry.fileName.match(/user_orders-(\d+)\.csv$/i)?.[1]));
        if (indexes.some((value) => !Number.isInteger(value)) || new Set(indexes).size !== indexes.length) {
          throw this.error('ZIP_AMBIGUOUS_EXPORT', 'The ZIP contains ambiguous Uber Eats order files.');
        }
        entries.sort((left, right) => Number(left.fileName.match(/(\d+)\.csv$/)?.[1]) - Number(right.fileName.match(/(\d+)\.csv$/)?.[1]));
      }
      if (entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > MAX_CSV_BYTES) {
        throw this.error('ZIP_OUTPUT_TOO_LARGE', 'The extracted CSV exceeds the safe size limit.');
      }
      return { zipfile, candidates: entries };
    } catch (error) {
      zipfile.close();
      throw error;
    }
  }

  private assertSafeEntry(entry: yauzl.Entry): void {
    const name = entry.fileName;
    if (!name || Buffer.byteLength(name) > MAX_PATH_BYTES || name.includes('\0') || name.includes('\\')) {
      throw this.error('ZIP_UNSAFE_ENTRY', 'The ZIP contains an unsafe path.');
    }
    let decoded: string;
    try { decoded = decodeURIComponent(name); } catch { throw this.error('ZIP_UNSAFE_ENTRY', 'The ZIP contains an unsafe path.'); }
    const normalized = path.posix.normalize(decoded);
    if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
      throw this.error('ZIP_UNSAFE_ENTRY', 'The ZIP contains an unsafe path.');
    }
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw this.error('ZIP_ENCRYPTED', 'Encrypted ZIP entries are not supported.');
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type && type !== 0o100000 && type !== 0o040000) throw this.error('ZIP_UNSAFE_ENTRY', 'The ZIP contains an unsupported file type.');
    if (entry.compressedSize === 0 ? entry.uncompressedSize > 1_024 : entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
      throw this.error('ZIP_COMPRESSION_RATIO', 'The ZIP has a suspicious compression ratio.');
    }
  }

  private matches(name: string, provider: ExportProvider): boolean {
    const normalized = name.replace(/\\/g, '/').toLowerCase();
    if (provider === 'doordash') return path.posix.basename(normalized) === 'consumer_order_details.csv';
    return normalized.includes('/eats/') && /(?:^|\/)user_orders-\d+\.csv$/.test(normalized);
  }

  private openEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream & AsyncIterable<unknown>> {
    return new Promise((resolve, reject) => zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(this.error('ZIP_INVALID', 'The ZIP entry could not be read.'));
      else resolve(stream as NodeJS.ReadableStream & AsyncIterable<unknown>);
    }));
  }

  private error(code: string, message: string): AppError {
    return new AppError({ code, message, publicMessage: message });
  }
}
