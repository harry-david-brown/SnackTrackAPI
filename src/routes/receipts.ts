import { Router, Request, Response } from 'express';
import { ReceiptService, ReceiptFilters } from '../services/ReceiptService';
import { PostgresService } from '../services/PostgresService';
import { ReceiptType } from '../models/Receipt';

const router = Router();
const postgresService = new PostgresService();
const receiptService = new ReceiptService(postgresService);

// GET /receipts - Get all receipts with optional filters
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters: ReceiptFilters = {};
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    // Parse filters from query parameters
    if (req.query.userId) filters.userId = req.query.userId as string;
    if (req.query.receiptType) filters.receiptType = req.query.receiptType as ReceiptType;
    if (req.query.restaurantName) filters.restaurantName = req.query.restaurantName as string;
    if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
    if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
    if (req.query.minAmount) filters.minAmount = parseFloat(req.query.minAmount as string);
    if (req.query.maxAmount) filters.maxAmount = parseFloat(req.query.maxAmount as string);

    const receipts = await receiptService.getReceipts(filters, limit, offset);
    res.json(receipts);
  } catch (err) {
    console.error('Error fetching receipts:', err);
    res.status(500).json({ error: 'Failed to fetch receipts' });
  }
});

// GET /receipts/:id - Get a specific receipt
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const receipt = await receiptService.getReceiptById(req.params.id);
    
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    res.json(receipt);
  } catch (err) {
    console.error('Error fetching receipt:', err);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

// POST /receipts - Create a new receipt
router.post('/', async (req: Request, res: Response) => {
  try {
    const receiptData = req.body;
    
    // Validate required fields
    if (!receiptData.userId || !receiptData.amountSpent) {
      return res.status(400).json({ 
        error: 'userId and amountSpent are required' 
      });
    }

    const receiptId = await receiptService.createReceipt(receiptData);
    res.status(201).json({ id: receiptId, message: 'Receipt created successfully' });
  } catch (err) {
    console.error('Error creating receipt:', err);
    res.status(500).json({ error: 'Failed to create receipt' });
  }
});

// PUT /receipts/:id - Update a receipt
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    const success = await receiptService.updateReceipt(req.params.id, updates);
    
    if (!success) {
      return res.status(404).json({ error: 'Receipt not found or no changes made' });
    }

    res.json({ message: 'Receipt updated successfully' });
  } catch (err) {
    console.error('Error updating receipt:', err);
    res.status(500).json({ error: 'Failed to update receipt' });
  }
});

// DELETE /receipts/:id - Delete a receipt
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const success = await receiptService.deleteReceipt(req.params.id);
    
    if (!success) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    res.json({ message: 'Receipt deleted successfully' });
  } catch (err) {
    console.error('Error deleting receipt:', err);
    res.status(500).json({ error: 'Failed to delete receipt' });
  }
});

// GET /receipts/analytics/:userId - Get spending analytics for a user
router.get('/analytics/:userId', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    const analytics = await receiptService.getReceiptAnalytics(userId, startDate, endDate);
    res.json(analytics);
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// POST /receipts/analyze - Email-only analysis endpoint (perfect for viral app!)
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // This is where we'll integrate with the existing email parsing logic
    // For now, return a mock response to show the structure
    res.json({
      message: 'Email analysis endpoint - ready for integration!',
      email: email,
      note: 'This will fetch and parse receipts from the provided email address'
    });
  } catch (err) {
    console.error('Error analyzing email:', err);
    res.status(500).json({ error: 'Failed to analyze email' });
  }
});

export default router;
