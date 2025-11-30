/**
 * ZIP Extractor Service
 * 
 * Extracts CSV files from ZIP archives for multiple platforms:
 * - Uber Eats: [path]/Uber Data/Eats/user_orders-0.csv
 * - DoorDash: [path]/data_archive/consumer_order_details.csv
 */

import AdmZip from 'adm-zip';
import { ValidationError } from '../../middleware/errorHandler';

export interface ExtractedFile {
  content: Buffer;
  filename: string;
  path: string;
  platform?: 'uber' | 'doordash';
}

export type Platform = 'uber' | 'doordash' | 'unknown';

export class ZipExtractor {
  /**
   * Detect platform from ZIP file structure
   */
  detectPlatform(zipBuffer: Buffer): Platform {
    try {
      const zip = new AdmZip(zipBuffer);
      const zipEntries = zip.getEntries();

      // Check for DoorDash pattern: data_archive/consumer_order_details.csv or consumer_order_details.csv at root
      const doorDashEntry = zipEntries.find(entry => {
        const path = entry.entryName.toLowerCase();
        return (
          path.includes('consumer_order_details') &&
          path.endsWith('.csv') &&
          !entry.isDirectory
        );
      });

      if (doorDashEntry) {
        return 'doordash';
      }

      // Check for Uber pattern: Uber Data/Eats/user_orders-0.csv
      const uberEntry = zipEntries.find(entry => {
        const path = entry.entryName.toLowerCase();
        return (
          (path.includes('uber data/eats/') && path.endsWith('user_orders-0.csv')) ||
          (path.includes('eats') && path.includes('user_orders') && path.endsWith('.csv'))
        ) && !entry.isDirectory;
      });

      if (uberEntry) {
        return 'uber';
      }

      return 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Extract CSV from ZIP based on detected platform
   */
  extractCSV(zipBuffer: Buffer): ExtractedFile {
    const platform = this.detectPlatform(zipBuffer);

    if (platform === 'doordash') {
      return this.extractDoorDashCSV(zipBuffer);
    } else if (platform === 'uber') {
      return this.extractUberEatsCSV(zipBuffer);
    } else {
      throw new ValidationError(
        'Could not detect platform. Expected Uber Eats or DoorDash data export ZIP file.',
        'file'
      );
    }
  }

  /**
   * Extract consumer_order_details.csv from DoorDash data ZIP
   * 
   * Searches for the file in the DoorDash data structure:
   * data_archive/consumer_order_details.csv
   */
  extractDoorDashCSV(zipBuffer: Buffer): ExtractedFile {
    try {
      const zip = new AdmZip(zipBuffer);
      const zipEntries = zip.getEntries();

      // Search for consumer_order_details.csv (can be in data_archive/ or at root)
      const csvEntry = zipEntries.find(entry => {
        const path = entry.entryName.toLowerCase();
        
        // Match pattern: consumer_order_details.csv (at root or in data_archive/)
        return (
          path.includes('consumer_order_details') &&
          path.endsWith('.csv') &&
          !entry.isDirectory
        );
      });

      if (!csvEntry) {
        throw new ValidationError(
          'Could not find DoorDash CSV in ZIP file. Expected file: consumer_order_details.csv',
          'file'
        );
      }

      const content = csvEntry.getData();

      // Validate content is not empty
      if (!content || content.length === 0) {
        throw new ValidationError('CSV file is empty', 'file');
      }

      return {
        content,
        filename: csvEntry.entryName.split('/').pop() || 'consumer_order_details.csv',
        path: csvEntry.entryName,
        platform: 'doordash'
      };

    } catch (error: any) {
      if (error instanceof ValidationError) {
        throw error;
      }

      // Handle ZIP corruption or invalid format
      if (error.message?.includes('invalid') || error.message?.includes('corrupt')) {
        throw new ValidationError('ZIP file is corrupted or invalid', 'file');
      }

      throw new ValidationError(
        `Failed to extract ZIP file: ${error.message}`,
        'file'
      );
    }
  }

  /**
   * Extract user_orders-0.csv from Uber data ZIP
   * 
   * Searches for the file in the Uber data structure:
   * Uber Data Request {hash}/Uber Data/Eats/user_orders-0.csv
   */
  extractUberEatsCSV(zipBuffer: Buffer): ExtractedFile {
    try {
      const zip = new AdmZip(zipBuffer);
      const zipEntries = zip.getEntries();

      // Search for user_orders-0.csv in Uber Data/Eats/ directory
      const csvEntry = zipEntries.find(entry => {
        const path = entry.entryName.toLowerCase();
        
        // Match pattern: [any path]/uber data/eats/user_orders-0.csv
        return (
          path.includes('uber data/eats/') && 
          path.endsWith('user_orders-0.csv') &&
          !entry.isDirectory
        );
      });

      if (!csvEntry) {
        // Try alternative patterns
        const alternativeCsvEntry = zipEntries.find(entry => {
          const path = entry.entryName.toLowerCase();
          return (
            path.includes('eats') && 
            path.includes('user_orders') && 
            path.endsWith('.csv') &&
            !entry.isDirectory
          );
        });

        if (alternativeCsvEntry) {
          const content = alternativeCsvEntry.getData();
          return {
            content,
            filename: alternativeCsvEntry.entryName.split('/').pop() || 'user_orders.csv',
            path: alternativeCsvEntry.entryName,
            platform: 'uber'
          };
        }

        throw new ValidationError(
          'Could not find Uber Eats CSV in ZIP file. Expected path: [any]/Uber Data/Eats/user_orders-0.csv',
          'file'
        );
      }

      const content = csvEntry.getData();

      // Validate content is not empty
      if (!content || content.length === 0) {
        throw new ValidationError('CSV file is empty', 'file');
      }

      return {
        content,
        filename: csvEntry.entryName.split('/').pop() || 'user_orders-0.csv',
        path: csvEntry.entryName,
        platform: 'uber'
      };

    } catch (error: any) {
      if (error instanceof ValidationError) {
        throw error;
      }

      // Handle ZIP corruption or invalid format
      if (error.message?.includes('invalid') || error.message?.includes('corrupt')) {
        throw new ValidationError('ZIP file is corrupted or invalid', 'file');
      }

      throw new ValidationError(
        `Failed to extract ZIP file: ${error.message}`,
        'file'
      );
    }
  }

  /**
   * Check if a buffer is a ZIP file based on magic bytes
   */
  isZipFile(buffer: Buffer): boolean {
    // ZIP files start with 'PK' (0x504B)
    if (buffer.length < 4) {
      return false;
    }

    return buffer[0] === 0x50 && buffer[1] === 0x4B;
  }

  /**
   * Get list of all entries in ZIP for debugging
   */
  listZipContents(zipBuffer: Buffer): string[] {
    try {
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      return entries
        .filter(entry => !entry.isDirectory)
        .map(entry => entry.entryName);
    } catch (error) {
      return [];
    }
  }

  /**
   * Validate ZIP structure and size
   */
  validateZipFile(buffer: Buffer, maxSizeMB: number = 50): void {
    // Check if it's a ZIP file
    if (!this.isZipFile(buffer)) {
      throw new ValidationError(
        'File is not a valid ZIP archive. Please upload a ZIP file from Uber Eats or DoorDash.',
        'file'
      );
    }

    // Check size (in MB)
    const sizeMB = buffer.length / (1024 * 1024);
    if (sizeMB > maxSizeMB) {
      throw new ValidationError(
        `File size (${sizeMB.toFixed(1)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
        'file'
      );
    }

    // Try to read the ZIP
    try {
      const zip = new AdmZip(buffer);
      zip.getEntries(); // This will throw if ZIP is corrupted
    } catch (error) {
      throw new ValidationError('ZIP file is corrupted or invalid', 'file');
    }
  }
}

