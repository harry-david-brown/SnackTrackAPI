#!/usr/bin/env node

/**
 * Helper script to insert test receipts directly into the database for pagination testing
 * Usage: node tests/insert-test-receipts.js <userId> [count]
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const userId = process.argv[2];
const count = parseInt(process.argv[3] || '25', 10);

if (!userId) {
  console.error('Usage: node tests/insert-test-receipts.js <userId> [count]');
  process.exit(1);
}

// Get database connection from environment or use defaults
const dbUrl = process.env.DATABASE_URL || 'postgresql://snacktrack:password@localhost:5432/snacktrack_dev';

const pool = new Pool({
  connectionString: dbUrl,
});

async function insertTestReceipts() {
  const client = await pool.connect();
  
  try {
    console.log(`Inserting ${count} test receipts for user: ${userId}`);
    
    for (let i = 1; i <= count; i++) {
      const restaurantName = `Test Restaurant ${(i % 5) + 1}`;
      const amountCents = Math.floor(Math.random() * 5000) + 1000; // $10.00 to $50.00
      const amountDecimal = (amountCents / 100).toFixed(2);
      const daysAgo = Math.floor(Math.random() * 90);
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() - daysAgo);
      
      await client.query(`
        INSERT INTO receipts (
          id, user_id, restaurant_name, amount_spent, currency, 
          receipt_type, data_source, created_at, updated_at, year
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9
        )
      `, [
        uuidv4(),
        userId,
        restaurantName,
        parseFloat(amountDecimal),
        'USD',
        'uber_eats',
        'csv',
        orderDate.toISOString(),
        orderDate.getFullYear()
      ]);
      
      if (i % 5 === 0) {
        process.stdout.write('.');
      }
    }
    
    console.log('');
    console.log(`✅ Inserted ${count} test receipts for user ${userId}`);
  } catch (error) {
    console.error('Error inserting test receipts:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

insertTestReceipts();

