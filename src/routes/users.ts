import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, NotFoundError, DatabaseError } from '../middleware/errorHandler';
import { validateUUIDParam, validateUserCreation } from '../middleware/validation';
import { userCreationRateLimit, emailOperationRateLimit } from '../middleware/security';

const router = Router();
const databaseService = container.databaseService;

/**
 * @swagger
 * /users/create:
 *   post:
 *     summary: Create a new user
 *     description: Create a new user account with an email address
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateUserRequest'
 *           example:
 *             email: "user@example.com"
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateUserResponse'
 *             example:
 *               id: "550e8400-e29b-41d4-a716-446655440000"
 *               message: "User created successfully"
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Create a new user (with rate limiting)
router.post('/create', userCreationRateLimit, validateUserCreation, asyncHandler(async (req: Request, res: Response) => {
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

/**
 * @swagger
 * /users/{id}/totalSpent:
 *   get:
 *     summary: Get user's total spending
 *     description: Retrieve the total amount spent by a user across all receipts
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Total spending retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: number
 *                   format: float
 *                   description: Total amount spent
 *                   example: 1250.75
 *             example:
 *               total: 1250.75
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

// Update user receipts from emails (with rate limiting)
router.post('/:id/update-receipts', emailOperationRateLimit, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
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