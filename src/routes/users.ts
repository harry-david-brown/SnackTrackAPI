import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, NotFoundError, DatabaseError } from '../middleware/errorHandler';
import { validateUUIDParam, validateUserCreation } from '../middleware/validation';

const router = Router();
const databaseService = container.databaseService;

// Create a new user
router.post('/create', validateUserCreation, asyncHandler(async (req: Request, res: Response) => {
  try {
    const id = await databaseService.createUser(req.body);
    res.status(201).json({ 
      id,
      message: 'User created successfully'
    });
  } catch (error) {
    throw new DatabaseError('Failed to create user', error as Error);
  }
}));

// Get user's total spending
router.get('/:id/totalSpent', validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    // First check if user exists
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      throw new NotFoundError('User', req.params.id);
    }
    
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ total });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to get user total spent', error as Error);
  }
}));

// Update user receipts from emails
router.post('/:id/update-receipts', validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    await databaseService.updateUserReceiptsForUser(req.params.id);
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ 
      message: 'Receipts updated successfully',
      total 
    });
  } catch (error) {
    throw new DatabaseError('Failed to update receipts', error as Error);
  }
}));

// Debug endpoint to test email fetching and parsing
router.get('/:id/debug/emails', validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      throw new NotFoundError('User', req.params.id);
    }
    
    const emails = await container.receiptLookupService.getUserEmails(user);
    const receipts = emails.map((email: any) => ({
      from: email.from,
      to: email.to,
      body: email.body,
      parsedReceipt: email.toReceipt()
    }));
    
    res.json({
      user: user.email,
      emailCount: emails.length,
      emails: receipts
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to fetch emails', error as Error);
  }
}));

export default router; 