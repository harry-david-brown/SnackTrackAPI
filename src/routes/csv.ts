import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { container } from '../services/core/ServiceContainer';
import { csvImportRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { concurrencyLimiter } from '../middleware/concurrencyLimiter';
import logger from '../config/logger';

const router = Router();

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
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      throw new ValidationError('No file uploaded. Please upload a CSV or ZIP file.', 'csvFile');
    }

    const filePath = req.file.path;
    try {
      const userId = typeof req.body.userId === 'string' ? req.body.userId : undefined;
      if (!userId) throw new ValidationError('userId is required', 'userId');

      let csvBuffer: Buffer;
      const isZip = await container.zipExtractor.isZipFile(filePath);

      if (isZip) {
        const extractedFile = await container.zipExtractor.extractCSV(filePath);
        csvBuffer = extractedFile.content;
      } else {
        csvBuffer = await fs.promises.readFile(filePath);
      }

      const result = await container.csvImportUseCase.execute({
        userId,
        csvBuffer,
        fileType: isZip ? 'zip' : 'csv',
      });
      res.json(result);
    } finally {
      await fs.promises.unlink(filePath).catch((error) => {
        logger.warn('Failed to delete temporary import file', { error });
      });
    }
  }));

export default router;
