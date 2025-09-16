import { Router, Request, Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { LookupService } from '../services/LookupService';

const router = Router();
const lookupService = new LookupService();
const databaseService = new DatabaseService(lookupService);

router.post('/create', async (req: Request, res: Response) => {
  try {
    const id = await databaseService.createUser(req.body);
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.get('/:id/totalSpent', async (req: Request, res: Response) => {
  try {
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get total spent' });
  }
});

// Update user receipts from emails
router.post('/:id/update-receipts', async (req: Request, res: Response) => {
  try {
    await databaseService.updateUserReceiptsForUser(req.params.id);
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ message: 'Receipts updated', total });
  } catch (err) {
    console.error('Update receipts error:', err);
    res.status(500).json({ error: 'Failed to update receipts', details: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Debug endpoint to test email fetching and parsing
router.get('/:id/debug/emails', async (req: Request, res: Response) => {
  try {
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const emails = await lookupService.getUserEmails(user);
    const receipts = emails.map(email => ({
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
  } catch (err) {
    console.error('Debug endpoint error:', err);
    res.status(500).json({ error: 'Failed to fetch emails', details: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router; 