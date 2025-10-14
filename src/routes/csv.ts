import { Router, Request, Response } from 'express';
import multer from 'multer';
import { container } from '../services/core/ServiceContainer';
import { csvImportRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { ZipExtractor } from '../services/import/ZipExtractor';
import { ValidationError } from '../middleware/errorHandler';
import { cacheService } from '../services/core/CacheService';

const router = Router();
const csvImportService = container.csvImportService;
const zipExtractor = new ZipExtractor();

// Configure multer for file uploads (CSV and ZIP)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream' // Sometimes ZIP files are sent as octet-stream
    ];
    
    const allowedExtensions = ['.csv', '.zip'];
    const fileExtension = file.originalname.toLowerCase().slice(-4);
    
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
 *     description: Import receipt data from a CSV file or ZIP archive (Uber Eats data export). ZIP files are automatically extracted to find user_orders-0.csv.
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
 *                 description: CSV file or ZIP archive containing Uber Eats data (max 50MB)
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
 *                   example: "Could not find Uber Eats CSV in ZIP file"
 *                 hint:
 *                   type: string
 *                   example: "Make sure you uploaded the complete Uber data export ZIP file"
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
 */
// POST /csv/import - Import parsed CSV or ZIP data to database
router.post('/import', authenticateToken, validateOwnership, csvImportRateLimit, upload.single('csvFile'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded. Please upload a CSV or ZIP file.' 
      });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    let csvBuffer: Buffer;
    let fileName = req.file.originalname;

    // Check if file is a ZIP
    const isZip = zipExtractor.isZipFile(req.file.buffer) || 
                  fileName.toLowerCase().endsWith('.zip');

    if (isZip) {
      console.log(`📦 Processing ZIP file: ${fileName}`);
      
      // Validate ZIP file
      zipExtractor.validateZipFile(req.file.buffer, 50);
      
      // Extract CSV from ZIP
      try {
        const extractedFile = zipExtractor.extractUberEatsCSV(req.file.buffer);
        csvBuffer = extractedFile.content;
        fileName = extractedFile.filename;
        
        console.log(`✅ Extracted CSV from ZIP: ${extractedFile.path}`);
      } catch (error) {
        if (error instanceof ValidationError) {
          return res.status(400).json({
            error: error.message,
            hint: 'Make sure you uploaded the complete Uber data export ZIP file'
          });
        }
        throw error;
      }
    } else {
      console.log(`📄 Processing CSV file: ${fileName}`);
      csvBuffer = req.file.buffer;
    }

    // Validate CSV format
    const validation = csvImportService.validateCsvFormat(csvBuffer);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid CSV format',
        details: validation.errors,
        hint: 'Please download a fresh export from Uber Eats'
      });
    }

    // Parse and import CSV
    const importResult = await csvImportService.parseCsvFile(csvBuffer, userId);
    
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
  }
});

export default router;