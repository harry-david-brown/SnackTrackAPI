// Reference Node.js types for process and environment
/// <reference types="node" />
// @ts-ignore
import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import usersRouter from './routes/users';

dotenv.config();

const app = express();
app.use(express.json());

// Health check
app.get('/', (req: Request, res: Response) => {
  res.send('ALIVE');
});

// OAuth callback handler
app.get('/auth/callback', (req: Request, res: Response) => {
  const code = req.query.code;
  if (code) {
    res.send(`
      <html>
        <body>
          <h2>✅ Authorization Successful!</h2>
          <p>Authorization code: <code>${code}</code></p>
          <p>Copy this code and paste it into your terminal where the script is waiting.</p>
        </body>
      </html>
    `);
  } else {
    res.status(400).send('No authorization code received');
  }
});

// Mount /users router
app.use('/users', usersRouter);

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 