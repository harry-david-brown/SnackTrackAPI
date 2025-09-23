import { Router, Request, Response } from 'express';
import multer from 'multer';
import { CsvImportService } from '../services/CsvImportService';
import { PostgresService } from '../services/PostgresService';

const router = Router();
const postgresService = new PostgresService();
const csvImportService = new CsvImportService(postgresService);

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Only allow CSV files
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// POST /csv/upload - Upload and parse CSV file
router.post('/upload', upload.single('csvFile'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Validate CSV format
    const validation = csvImportService.validateCsvFormat(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Invalid CSV format', 
        details: validation.errors 
      });
    }

    // Parse CSV
    const result = await csvImportService.parseCsvFile(req.file.buffer, userId);
    
    res.json({
      message: 'CSV parsed successfully',
      preview: {
        totalOrders: result.totalOrders,
        totalReceipts: result.totalReceipts,
        totalAmount: result.totalAmount,
        errors: result.errors,
        sampleReceipts: result.receipts.slice(0, 3) // Show first 3 receipts as preview
      }
    });

  } catch (error) {
    console.error('CSV upload error:', error);
    res.status(500).json({ 
      error: 'Failed to process CSV file', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// POST /csv/import - Import parsed CSV data to database
router.post('/import', upload.single('csvFile'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Parse CSV
    const result = await csvImportService.parseCsvFile(req.file.buffer, userId);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: 'CSV parsing failed', 
        details: result.errors 
      });
    }

    try {
      // Import to database
      await csvImportService.importReceipts(result.receipts, userId);
      
      res.json({
        message: 'CSV imported successfully',
        summary: {
          totalOrders: result.totalOrders,
          totalReceipts: result.totalReceipts,
          totalAmount: result.totalAmount,
          importedAt: new Date().toISOString()
        }
      });
    } catch (dbError) {
      // Log the actual error for debugging
      console.error('Database import error:', dbError);
      
      res.status(500).json({
        message: 'CSV parsed successfully but database import failed',
        error: dbError instanceof Error ? dbError.message : 'Unknown database error',
        summary: {
          totalOrders: result.totalOrders,
          totalReceipts: result.totalReceipts,
          totalAmount: result.totalAmount,
          parsedAt: new Date().toISOString(),
          note: 'Data parsed but not saved to database'
        }
      });
    }

  } catch (error) {
    console.error('CSV import error:', error);
    res.status(500).json({ 
      error: 'Failed to import CSV data', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// POST /csv/preview - Preview CSV data without importing
router.post('/preview', upload.single('csvFile'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const userId = req.body.userId || 'preview-user';

    // Parse CSV
    const result = await csvImportService.parseCsvFile(req.file.buffer, userId);
    
    res.json({
      message: 'CSV preview generated',
      summary: {
        totalOrders: result.totalOrders,
        totalReceipts: result.totalReceipts,
        totalAmount: result.totalAmount,
        errors: result.errors,
        sampleReceipts: result.receipts.slice(0, 5), // Show first 5 receipts
        allReceipts: result.receipts // Include all receipts for full preview
      }
    });

  } catch (error) {
    console.error('CSV preview error:', error);
    res.status(500).json({ 
      error: 'Failed to preview CSV file', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// GET /csv/status/:userId - Get import status for a user
router.get('/status/:userId', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    
    // Get receipt count and total amount for user
    const result = await postgresService.query(`
      SELECT 
        COUNT(*) as receipt_count,
        COALESCE(SUM(amount_spent), 0) as total_amount,
        MIN(order_date) as earliest_order,
        MAX(order_date) as latest_order
      FROM receipts 
      WHERE user_id = $1
    `, [userId]);

    const stats = result.rows[0];
    
    res.json({
      userId,
      receiptCount: parseInt(stats.receipt_count),
      totalAmount: parseFloat(stats.total_amount),
      earliestOrder: stats.earliest_order,
      latestOrder: stats.latest_order,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('CSV status error:', error);
    res.status(500).json({ 
      error: 'Failed to get import status', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;
