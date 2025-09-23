import { Router, Request, Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { LookupService } from '../services/LookupService';
import { PostgresService } from '../services/PostgresService';

const router = Router();
const postgresService = new PostgresService();
const lookupService = new LookupService();
const databaseService = new DatabaseService(lookupService, postgresService);

router.post('/create', async (req: Request, res: Response) => {
  try {
    const id = await databaseService.createUser(req.body);
    res.json({ id });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user', details: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Create a user specifically for CSV import (no email required)
router.post('/create-csv', async (req: Request, res: Response) => {
  try {
    // Create user with minimal data for CSV import
    const result = await postgresService.query(
      'INSERT INTO users (email, account_type) VALUES ($1, $2) RETURNING id',
      [`csv-user-${Date.now()}@snacktrack.local`, 'CSV']
    );
    
    const userId = result.rows[0].id;
    res.json({ 
      id: userId,
      message: 'CSV user created successfully',
      dataSource: 'CSV'
    });
  } catch (err) {
    console.error('Error creating CSV user:', err);
    res.status(500).json({ error: 'Failed to create CSV user', details: err instanceof Error ? err.message : 'Unknown error' });
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