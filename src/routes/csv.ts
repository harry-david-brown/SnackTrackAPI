import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { container } from '../services/core/ServiceContainer';
import { csvImportRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { ZipExtractor } from '../services/import/ZipExtractor';
import { ValidationError } from '../middleware/errorHandler';
import { cacheService } from '../services/core/CacheService';
import { concurrencyLimiter } from '../middleware/concurrencyLimiter';

const router = Router();
const csvImportService = container.csvImportService;
const zipExtractor = new ZipExtractor();

// Configure multer for file uploads (CSV and ZIP) with Disk Storage
// Saves to temp directory to prevent RAM exhaustion
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      // Generate a unique filename
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size on disk
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream' // Sometimes ZIP files are sent as octet-stream
    ];

    const allowedExtensions = ['.csv', '.zip'];

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.some(ext => file.originalname.toLowerCase().endsWith(ext))) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and ZIP files are allowed'));
    }
  }
});

/**
 * @swagger
 * /csv/import:
 *   post:
 *     summary: Import CSV or ZIP file
 *     description: Import receipt data from a CSV file or ZIP archive (Uber Eats or DoorDash data export). ZIP files are automatically extracted and platform is auto-detected.
 *     tags: [CSV Import]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - csvFile
 *               - userId
 *             properties:
 *               csvFile:
 *                 type: string
 *                 format: binary
 *                 description: CSV file or ZIP archive containing Uber Eats or DoorDash data (max 50MB)
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: User ID to associate receipts with
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: File imported successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "ZIP file processed and receipts imported successfully"
 *                 importedCount:
 *                   type: integer
 *                   example: 150
 *                 totalAmount:
 *                   type: number
 *                   example: 1250.75
 *                 fileType:
 *                   type: string
 *                   enum: [csv, zip]
 *                   example: "zip"
 *       400:
 *         description: Bad request (invalid file, missing CSV in ZIP, or invalid format)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Could not find CSV in ZIP file"
 *                 hint:
 *                   type: string
 *                   example: "Make sure you uploaded the complete Uber Eats or DoorDash data export ZIP file"
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - userId does not match authenticated user
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       413:
 *         description: Payload Too Large
 */
// POST /csv/import - Import parsed CSV or ZIP data to database
// Note on middleware order: upload.single MUST be before validateOwnership because
// validateOwnership reads req.body.userId, which is only populated by multer after parsing.
router.post('/import',
  authenticateToken,
  csvImportRateLimit,
  concurrencyLimiter,
  upload.single('csvFile'),
  validateOwnership,
  async (req: Request, res: Response) => {

    // Ensure file was uploaded
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded. Please upload a CSV or ZIP file.'
      });
    }

    const filePath = req.file.path;

    try {
      const userId = req.body.userId;
      if (!userId) {
        // Should be caught by validateOwnership if it wasn't empty, but good to double check
        return res.status(400).json({ error: 'userId is required' });
      }

      let csvBuffer: Buffer;
      let fileName = req.file.originalname;

      // Check if file is a ZIP (using new Promise-based check from disk)
      const isZip = await zipExtractor.isZipFile(filePath);

      if (isZip) {
        console.log(`📦 Processing ZIP file: ${fileName}`);

        // Extract CSV from ZIP (Streaming from disk, with zip bomb protection)
        // No need to call validateZipFile separately as extractCSV handles it
        try {
          const extractedFile = await zipExtractor.extractCSV(filePath);
          csvBuffer = extractedFile.content;
          fileName = extractedFile.filename;

          const platform = extractedFile.platform === 'uber' ? 'Uber Eats' :
            extractedFile.platform === 'doordash' ? 'DoorDash' : 'Unknown';
          console.log(`✅ Extracted ${platform} CSV from ZIP: ${extractedFile.path}`);
        } catch (error: any) {
          if (error instanceof ValidationError) {
            return res.status(400).json({
              error: error.message,
              hint: 'Make sure you uploaded the complete Uber Eats or DoorDash data export ZIP file'
            });
          }
          throw error;
        }
      } else {
        console.log(`📄 Processing CSV file: ${fileName}`);
        // For CSV files, we read from disk
        csvBuffer = await fs.promises.readFile(filePath);
      }

      // Validate CSV format (auto-detects Uber Eats or DoorDash)
      const validation = csvImportService.validateCsvFormat(csvBuffer);
      if (!validation.valid) {
        const format = csvImportService.detectCsvFormat(csvBuffer);
        const platformHint = format === 'unknown'
          ? 'Uber Eats or DoorDash'
          : format === 'uber'
            ? 'Uber Eats'
            : 'DoorDash';

        return res.status(400).json({
          error: 'Invalid CSV format',
          details: validation.errors,
          hint: `Please download a fresh export from ${platformHint}`
        });
      }

      // Process CSV synchronously (in-memory is fine for the CSV content itself if < 50MB)
      // Future improvement: Stream CSV parsing directly to DB to avoid large buffer in RAM
      const importResult = await csvImportService.parseCsvFile(csvBuffer, userId);

      // Check if we have any valid receipts to import
      if (importResult.receipts.length === 0) {
        return res.status(400).json({
          error: 'No valid orders found in file',
          details: importResult.errors.length > 0 ? importResult.errors : ['File contains no valid order data'],
          hint: 'Please ensure your data export includes completed orders. If you just placed an order, wait a few minutes for it to appear in your data export.'
        });
      }

      if (importResult.success && importResult.receipts.length > 0) {
        await csvImportService.importReceipts(importResult.receipts, userId);

        // Invalidate cached analytics since user data changed
        await cacheService.invalidateAllUserCaches(userId);

        console.log(`✅ Imported ${importResult.totalReceipts} receipts for user ${userId}`);
      }

      res.json({
        message: isZip
          ? 'ZIP file processed and receipts imported successfully'
          : 'CSV imported successfully',
        importedCount: importResult.totalReceipts,
        totalAmount: importResult.totalAmount,
        fileType: isZip ? 'zip' : 'csv'
      });

    } catch (error) {
      console.error('File import error:', error);

      if (error instanceof ValidationError) {
        return res.status(400).json({
          error: error.message
        });
      }

      res.status(500).json({
        error: 'Failed to import file',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      // Critical: Clean up temp file
      if (req.file && req.file.path) {
        fs.unlink(req.file.path, (err) => {
          if (err) console.error('Failed to delete temp file:', err);
        });
      }
    }
  });

export default router;