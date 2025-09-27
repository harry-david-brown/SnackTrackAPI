import { Router, Request, Response } from 'express';
import multer from 'multer';
import { container } from '../services/core/ServiceContainer';
import { csvImportRateLimit } from '../middleware/security';

const router = Router();
const csvImportService = container.csvImportService;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

/**
 * @swagger
 * /csv/import:
 *   post:
 *     summary: Import CSV file
 *     description: Import receipt data from a CSV file (Uber Eats, DoorDash, etc.)
 *     tags: [CSV Import]
 *     security:
 *       - ApiKeyAuth: []
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
 *                 description: CSV file containing receipt data
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: User ID to associate receipts with
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: CSV imported successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CSVImportResponse'
 *             example:
 *               message: "CSV imported successfully"
 *               importedCount: 150
 *       400:
 *         description: Bad request (invalid file or missing data)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /csv/import - Import parsed CSV data to database
router.post('/import', csvImportRateLimit, upload.single('csvFile'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const csvData = req.file.buffer.toString('utf8');
    const importedCount = await csvImportService.importReceipts(csvData, userId);
    
    res.json({
      message: 'CSV imported successfully',
      importedCount
    });
  } catch (error) {
    console.error('CSV import error:', error);
    res.status(500).json({ 
      error: 'Failed to import CSV data', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;