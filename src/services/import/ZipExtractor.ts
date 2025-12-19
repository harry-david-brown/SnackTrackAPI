/**
 * ZIP Extractor Service
 * 
 * Extracts CSV files from ZIP archives for multiple platforms:
 * - Uber Eats: [path]/Uber Data/Eats/user_orders-0.csv
 * - DoorDash: [path]/data_archive/consumer_order_details.csv
 * 
 * Security measures implemented:
 * - Zip Slip protection (path traversal prevention)
 * - Zip Bomb protection (size, file count, compression ratio limits)
 * - Symlink detection and rejection
 * - Sanitized error messages
 * - Basic CSV content validation
 */

import yauzl from 'yauzl';
import fs from 'fs';
import path from 'path';
import { ValidationError } from '../../middleware/errorHandler';

export interface ExtractedFile {
  content: Buffer;
  filename: string;
  path: string;
  platform?: 'uber' | 'doordash';
}

export type Platform = 'uber' | 'doordash' | 'unknown';

export class ZipExtractor {
  // Configurable limits
  private static MAX_UNCOMPRESSED_SIZE = 100 * 1024 * 1024; // 100MB limit for uncompressed data
  private static MAX_FILE_COUNT = 1000; // Limit number of files in zip to scan
  private static MAX_COMPRESSION_RATIO = 100; // Maximum allowed compression ratio (uncompressed/compressed)

  /**
   * Validate file path to prevent Zip Slip attacks
   * Checks for path traversal, absolute paths, and encoded variants
   */
  private isPathSafe(fileName: string): boolean {
    // Normalize the path to resolve any . or .. segments
    const normalizedPath = path.normalize(fileName);
    
    // Check for path traversal attempts
    if (normalizedPath.startsWith('..') || normalizedPath.includes('/..') || normalizedPath.includes('\\..')) {
      return false;
    }
    
    // Check for absolute paths (Unix and Windows)
    if (path.isAbsolute(normalizedPath) || /^[a-zA-Z]:/.test(normalizedPath)) {
      return false;
    }
    
    // Check for URL-encoded path traversal attempts
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(fileName);
    } catch {
      return false;
    }
    if (decodedPath.includes('..') || decodedPath !== fileName && path.normalize(decodedPath).startsWith('..')) {
      return false;
    }
    
    // Check for backslash variants (Windows-style paths in Unix context)
    if (fileName.includes('..\\') || fileName.includes('\\..')) {
      return false;
    }
    
    return true;
  }

  /**
   * Check if entry is a symbolic link based on external file attributes
   * Unix symlinks have mode 0120000 (octal) in the high 16 bits
   */
  private isSymlink(entry: yauzl.Entry): boolean {
    // External file attributes: high 16 bits contain Unix mode
    // Symlink mode is 0120000 (octal) = 40960 (decimal)
    const unixMode = (entry.externalFileAttributes >> 16) & 0xFFFF;
    const S_IFLNK = 0o120000; // Symbolic link file type
    return (unixMode & 0o170000) === S_IFLNK;
  }

  /**
   * Check compression ratio to detect potential zip bombs
   */
  private isCompressionRatioSafe(entry: yauzl.Entry): boolean {
    // If compressed size is 0 or very small, be cautious
    if (entry.compressedSize <= 0) {
      // Allow if uncompressed size is also small (empty or near-empty files)
      return entry.uncompressedSize <= 1024;
    }
    
    const ratio = entry.uncompressedSize / entry.compressedSize;
    return ratio <= ZipExtractor.MAX_COMPRESSION_RATIO;
  }

  /**
   * Basic validation that content appears to be CSV
   * Checks for printable ASCII/UTF-8 and common CSV patterns
   */
  private isValidCSVContent(content: Buffer): boolean {
    if (content.length === 0) {
      return false;
    }
    
    // Check first 1KB for basic CSV characteristics
    const sample = content.slice(0, 1024).toString('utf-8');
    
    // Check for binary content (non-printable characters except common whitespace)
    const nonPrintableRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
    if (nonPrintableRegex.test(sample)) {
      return false;
    }
    
    // Check for at least one comma or newline (basic CSV structure)
    if (!sample.includes(',') && !sample.includes('\n')) {
      return false;
    }
    
    return true;
  }

  /**
   * Sanitize filename for error messages to prevent information disclosure
   */
  private sanitizeFilenameForError(fileName: string): string {
    // Only show the base filename, not the full path
    const baseName = path.basename(fileName);
    // Truncate if too long
    if (baseName.length > 50) {
      return baseName.substring(0, 47) + '...';
    }
    return baseName;
  }

  /**
   * Extract CSV from ZIP based on detected platform (Streaming)
   * Prevents Zip Bombs by checking uncompressed size.
   */
  async extractCSV(filePath: string): Promise<ExtractedFile> {
    return new Promise((resolve, reject) => {
      // open with lazyEntries: true to read sequentially
      yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          return reject(new ValidationError('Failed to open ZIP file', 'file'));
        }
        if (!zipfile) {
          return reject(new ValidationError('Failed to open ZIP file', 'file'));
        }

        let foundEntry: yauzl.Entry | null = null;
        let platform: Platform = 'unknown';
        let entriesCount = 0;

        zipfile.readEntry();

        zipfile.on('entry', (entry: yauzl.Entry) => {
          entriesCount++;
          if (entriesCount > ZipExtractor.MAX_FILE_COUNT) {
            zipfile.close();
            return reject(new ValidationError('ZIP file contains too many files', 'file'));
          }

          // Security: Check for malicious paths (Zip Slip) - comprehensive check
          if (!this.isPathSafe(entry.fileName)) {
            zipfile.close();
            return reject(new ValidationError('Invalid file path detected in ZIP', 'file'));
          }

          // Security: Check for symbolic links
          if (this.isSymlink(entry)) {
            zipfile.close();
            return reject(new ValidationError('Symbolic links are not allowed in ZIP', 'file'));
          }

          const entryPath = entry.fileName.toLowerCase();

          // Logic to find the correct file
          let isMatch = false;

          // DoorDash match
          if (
            (entryPath.includes('consumer_order_details') || entryPath.includes('consumer_profile_details')) &&
            entryPath.endsWith('.csv') &&
            !entryPath.endsWith('/')
          ) {
            platform = 'doordash';
            isMatch = true;
          }
          // Uber match
          else if (
            ((entryPath.includes('uber data/eats/') && entryPath.endsWith('user_orders-0.csv')) ||
              (entryPath.includes('eats') && entryPath.includes('user_orders') && entryPath.endsWith('.csv'))) &&
            !entryPath.endsWith('/')
          ) {
            platform = 'uber';
            isMatch = true;
          }

          if (isMatch) {
            foundEntry = entry;
            
            // Zip Bomb Check: Uncompressed size
            if (entry.uncompressedSize > ZipExtractor.MAX_UNCOMPRESSED_SIZE) {
              zipfile.close();
              return reject(new ValidationError('File exceeds maximum allowed size (250MB)', 'file'));
            }

            // Zip Bomb Check: Compression ratio
            if (!this.isCompressionRatioSafe(entry)) {
              zipfile.close();
              return reject(new ValidationError('Suspicious compression ratio detected', 'file'));
            }

            // Extract this entry
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) {
                return reject(new ValidationError('Failed to read file from ZIP', 'file'));
              }

              const chunks: Buffer[] = [];
              let size = 0;

              readStream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > ZipExtractor.MAX_UNCOMPRESSED_SIZE) {
                  readStream.destroy();
                  zipfile.close();
                  return reject(new ValidationError('Extracted file exceeds size limit', 'file'));
                }
                chunks.push(chunk);
              });

              readStream.on('end', () => {
                zipfile.close();
                const content = Buffer.concat(chunks);

                // If the file is empty (e.g. Uber sometimes), we handle it
                if (content.length === 0 && platform === 'uber') {
                  // Return empty structure for Uber to handle "no orders" case gracefully
                  const emptyCsv = 'Restaurant_Name,Request_Time_Local,Order_Status,Item_Name,Item_quantity,Item_Price,Order_Price\n';
                  return resolve({
                    content: Buffer.from(emptyCsv),
                    filename: 'user_orders-0.csv',
                    path: 'Uber Data/Eats/user_orders-0.csv',
                    platform: 'uber'
                  });
                }

                if (content.length === 0) {
                  return reject(new ValidationError('CSV file is empty', 'file'));
                }

                // Security: Validate CSV content
                if (!this.isValidCSVContent(content)) {
                  return reject(new ValidationError('File does not appear to be valid CSV content', 'file'));
                }

                resolve({
                  content,
                  filename: this.sanitizeFilenameForError(entry.fileName),
                  path: entry.fileName,
                  platform: platform !== 'unknown' ? platform : undefined
                });
              });

              readStream.on('error', () => {
                reject(new ValidationError('Error reading file from ZIP', 'file'));
              });
            });
          } else {
            // Continue reading next entry
            zipfile.readEntry();
          }
        });

        zipfile.on('end', () => {
          if (!foundEntry) {
            // Fallback for Uber: Check if structure exists but file is missing (no orders)
            // This is tricky with sequential scanning, but if we reached the end without finding a match,
            // then we assume it's NOT a valid export.
            // (Logic for emptiness check in Uber zip was previously detecting folder existence, 
            // but here we just fail if we don't find the file).
            return reject(new ValidationError('Could not find Uber Eats or DoorDash CSV in ZIP file', 'file'));
          }
        });

        zipfile.on('error', (err) => {
          reject(new ValidationError('ZIP file corrupted or unreadable', 'file'));
        });
      });
    });
  }

  /**
   * Check if a file is a ZIP based on magic bytes (Reads first 4 bytes from disk)
   */
  async isZipFile(filePath: string): Promise<boolean> {
    try {
      const buffer = Buffer.alloc(4);
      const fd = await fs.promises.open(filePath, 'r');
      await fd.read(buffer, 0, 4, 0);
      await fd.close();
      return buffer[0] === 0x50 && buffer[1] === 0x4B; // PK
    } catch (e) {
      return false;
    }
  }

  /**
   * Validate ZIP structure
   * (Now mostly checking if it opens, since Multer handles upload size)
   */
  async validateZipFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) {
          return reject(new ValidationError('Invalid ZIP file or corrupted', 'file'));
        }
        zipfile.close();
        resolve();
      });
    });
  }
}
