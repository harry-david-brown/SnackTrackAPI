import { Router, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { requireObject, requireUuid } from '../http/validation/requestValues';
import type { CsvImportUseCase } from '../services/import/CsvImportUseCase';
import type { ZipExtractor } from '../services/import/ZipExtractor';

interface CsvRouteLogger {
  warn(message: string, metadata: Readonly<Record<string, unknown>>): void;
}

// Configure multer for file uploads (CSV and ZIP) with Disk Storage
// Saves to temp directory to prevent RAM exhaustion
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      // Generate a unique filename
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size on disk
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream', // Sometimes ZIP files are sent as octet-stream
    ];

    const allowedExtensions = ['.csv', '.zip'];

    if (
      allowedMimeTypes.includes(file.mimetype) ||
      allowedExtensions.some((ext) => file.originalname.toLowerCase().endsWith(ext))
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and ZIP files are allowed'));
    }
  },
});

export interface CsvRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly rateLimit: RequestHandler;
  readonly limitConcurrency: RequestHandler;
  readonly authorizeOwnership: RequestHandler;
  readonly zip: Pick<ZipExtractor, 'isZipFile' | 'extractCSV'>;
  readonly importCsv: Pick<CsvImportUseCase, 'execute'>;
  readonly logger: CsvRouteLogger;
}

export const createCsvRouter = (dependencies: CsvRouterDependencies): Router => {
  const router = Router();

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
   *               $ref: '#/components/schemas/CsvImportResult'
   *       400:
   *         $ref: '#/components/responses/ValidationError'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
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
  router.post(
    '/import',
    dependencies.authenticate,
    dependencies.rateLimit,
    dependencies.limitConcurrency,
    upload.single('csvFile'),
    dependencies.authorizeOwnership,
    asyncHandler(async (req: Request, res: Response) => {
      if (!req.file) {
        throw new ValidationError('No file uploaded. Please upload a CSV or ZIP file.', 'csvFile');
      }

      const filePath = req.file.path;
      try {
        const userId = requireUuid(requireObject(req.body as unknown).userId, 'userId');

        let csvBuffer: Buffer;
        const isZip = await dependencies.zip.isZipFile(filePath);

        if (isZip) {
          const extractedFile = await dependencies.zip.extractCSV(filePath);
          csvBuffer = extractedFile.content;
        } else {
          csvBuffer = await fs.promises.readFile(filePath);
        }

        const result = await dependencies.importCsv.execute({
          userId,
          csvBuffer,
          fileType: isZip ? 'zip' : 'csv',
        });
        res.json(result);
      } finally {
        await fs.promises.unlink(filePath).catch((error: unknown) => {
          dependencies.logger.warn('Failed to delete temporary import file', { error });
        });
      }
    }),
  );

  return router;
};
