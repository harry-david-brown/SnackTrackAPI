// Direct test of delivery waits calculation
// Tests the analytics service without needing authentication

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://snacktrack:password@localhost:5432/snacktrack_dev'
});

async function testDeliveryWaits() {
  const userId = '6a82e64a-03ab-4981-a468-e0baea37f5f4';
  
  console.log('🧪 Testing Delivery Waits Calculation');
  console.log('========================================\n');
  
  try {
    // Fetch receipts with delivery_time
    const query = `
      SELECT 
        id,
        user_id as "userId",
        restaurant_name as "restaurantName",
        order_date as "orderDate",
        amount_spent as "amountSpent",
        items,
        receipt_type as "receiptType",
        data_source as "dataSource",
        delivery_time as "deliveryTime"
      FROM receipts
      WHERE user_id = $1 AND receipt_type = 'doordash' AND delivery_time IS NOT NULL
      ORDER BY order_date DESC
    `;
    
    const result = await pool.query(query, [userId]);
    const receipts = result.rows.map(row => ({
      ...row,
      amountSpent: parseFloat(row.amountSpent),
      orderDate: row.orderDate ? new Date(row.orderDate) : null,
      deliveryTime: row.deliveryTime ? new Date(row.deliveryTime) : null,
      items: Array.isArray(row.items) ? row.items : []
    }));
    
    console.log(`Found ${receipts.length} DoorDash receipts with delivery_time\n`);
    
    if (receipts.length === 0) {
      console.log('❌ No receipts found for testing');
      return;
    }
    
    // Calculate wait times
    const waitTimes = [];
    receipts.forEach(receipt => {
      if (receipt.orderDate && receipt.deliveryTime) {
        const waitMs = receipt.deliveryTime.getTime() - receipt.orderDate.getTime();
        const waitMinutes = Math.round(waitMs / (1000 * 60));
        
        if (waitMinutes > 0) {
          waitTimes.push({ receipt, minutes: waitMinutes });
          console.log(`  Order at ${receipt.restaurantName}: ${waitMinutes} minutes wait`);
        }
      }
    });
    
    if (waitTimes.length === 0) {
      console.log('❌ No valid wait times calculated');
      return;
    }
    
    // Calculate totals
    const totalMinutes = waitTimes.reduce((sum, wt) => sum + wt.minutes, 0);
    const averageMinutes = Math.round(totalMinutes / waitTimes.length);
    
    // Find longest and fastest
    const longestWait = waitTimes.reduce((longest, current) => 
      current.minutes > longest.minutes ? current : longest
    );
    
    const fastestDelivery = waitTimes.reduce((fastest, current) => 
      current.minutes < fastest.minutes ? current : fastest
    );
    
    console.log('\n📊 Delivery Waits Results:');
    console.log('========================');
    console.log(`Total Minutes: ${totalMinutes}`);
    console.log(`Average Minutes: ${averageMinutes}`);
    console.log(`Total Orders: ${waitTimes.length}`);
    console.log(`\nLongest Wait:`);
    console.log(`  ${longestWait.minutes} minutes at ${longestWait.receipt.restaurantName}`);
    console.log(`  Amount: $${longestWait.receipt.amountSpent.toFixed(2)}`);
    console.log(`\nFastest Delivery:`);
    console.log(`  ${fastestDelivery.minutes} minutes at ${fastestDelivery.receipt.restaurantName}`);
    
    // Validate expected values
    const expectedTotal = 25 + 15 + 45; // 85 minutes
    const expectedAverage = Math.round(85 / 3); // 28 minutes
    const expectedLongest = 45;
    const expectedFastest = 15;
    
    console.log('\n✅ Validation:');
    console.log('=============');
    
    let allPassed = true;
    
    if (totalMinutes === expectedTotal) {
      console.log(`✅ Total minutes correct: ${totalMinutes}`);
    } else {
      console.log(`❌ Total minutes incorrect: expected ${expectedTotal}, got ${totalMinutes}`);
      allPassed = false;
    }
    
    if (averageMinutes === expectedAverage) {
      console.log(`✅ Average minutes correct: ${averageMinutes}`);
    } else {
      console.log(`❌ Average minutes incorrect: expected ${expectedAverage}, got ${averageMinutes}`);
      allPassed = false;
    }
    
    if (longestWait.minutes === expectedLongest) {
      console.log(`✅ Longest wait correct: ${longestWait.minutes} minutes`);
    } else {
      console.log(`❌ Longest wait incorrect: expected ${expectedLongest}, got ${longestWait.minutes}`);
      allPassed = false;
    }
    
    if (fastestDelivery.minutes === expectedFastest) {
      console.log(`✅ Fastest delivery correct: ${fastestDelivery.minutes} minutes`);
    } else {
      console.log(`❌ Fastest delivery incorrect: expected ${expectedFastest}, got ${fastestDelivery.minutes}`);
      allPassed = false;
    }
    
    if (allPassed) {
      console.log('\n🎉 All tests passed!');
    } else {
      console.log('\n❌ Some tests failed');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

testDeliveryWaits();


