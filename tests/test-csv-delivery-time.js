// Test CSV parsing to verify delivery_time is extracted and stored correctly

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const csv = require('csv-parser');

async function testCsvParsing() {
  console.log('🧪 Testing DoorDash CSV Parsing with delivery_time');
  console.log('==================================================\n');
  
  try {
    // Read the DoorDash CSV file
    const csvPath = path.join(__dirname, '../MockDoorDashData/data_archive/consumer_order_details.csv');
    const csvBuffer = fs.readFileSync(csvPath);
    
    console.log('✅ CSV file loaded\n');
    
    // Parse CSV rows
    const rows = [];
    const stream = Readable.from(csvBuffer.toString());
    
    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });
    
    console.log(`✅ Parsed ${rows.length} CSV rows\n`);
    
    if (rows.length === 0) {
      console.log('❌ No rows found in CSV');
      return;
    }
    
    // Check first few rows for CREATED_AT and DELIVERY_TIME
    console.log('Sample rows with delivery times:');
    console.log('=================================\n');
    
    let validRows = 0;
    let invalidRows = 0;
    
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const row = rows[i];
      const createdAt = row.CREATED_AT;
      const deliveryTime = row.DELIVERY_TIME;
      
      console.log(`Row ${i + 1}:`);
      console.log(`  CREATED_AT: ${createdAt}`);
      console.log(`  DELIVERY_TIME: ${deliveryTime}`);
      
      if (createdAt && deliveryTime) {
        try {
          const orderDate = new Date(createdAt);
          const deliveryDate = new Date(deliveryTime);
          
          if (!isNaN(orderDate.getTime()) && !isNaN(deliveryDate.getTime())) {
            const waitMs = deliveryDate.getTime() - orderDate.getTime();
            const waitMinutes = Math.round(waitMs / (1000 * 60));
            
            console.log(`  ✅ Both dates are valid`);
            console.log(`  Wait time: ${waitMinutes} minutes`);
            validRows++;
          } else {
            console.log(`  ❌ Invalid date format`);
            invalidRows++;
          }
        } catch (error) {
          console.log(`  ❌ Error parsing dates: ${error.message}`);
          invalidRows++;
        }
      } else {
        console.log(`  ❌ Missing CREATED_AT or DELIVERY_TIME`);
        invalidRows++;
      }
      console.log('');
    }
    
    // Group rows by order (same STORE_NAME, CREATED_AT, DELIVERY_TIME)
    const orderGroups = new Map();
    
    rows.forEach(row => {
      const orderKey = `${row.STORE_NAME}-${row.CREATED_AT}-${row.DELIVERY_TIME}`;
      
      if (!orderGroups.has(orderKey)) {
        orderGroups.set(orderKey, []);
      }
      orderGroups.get(orderKey).push(row);
    });
    
    console.log(`\n📊 Order Grouping:`);
    console.log(`  Total unique orders: ${orderGroups.size}`);
    console.log(`  Rows with valid dates: ${validRows}`);
    console.log(`  Rows with invalid dates: ${invalidRows}`);
    
    // Verify that orders have consistent CREATED_AT and DELIVERY_TIME
    let ordersWithValidTimes = 0;
    let ordersWithInvalidTimes = 0;
    
    orderGroups.forEach((orderRows, orderKey) => {
      const firstRow = orderRows[0];
      const createdAt = firstRow.CREATED_AT;
      const deliveryTime = firstRow.DELIVERY_TIME;
      
      if (createdAt && deliveryTime) {
        try {
          const orderDate = new Date(createdAt);
          const deliveryDate = new Date(deliveryTime);
          
          if (!isNaN(orderDate.getTime()) && !isNaN(deliveryDate.getTime())) {
            ordersWithValidTimes++;
          } else {
            ordersWithInvalidTimes++;
          }
        } catch (error) {
          ordersWithInvalidTimes++;
        }
      } else {
        ordersWithInvalidTimes++;
      }
    });
    
    console.log(`\n✅ Orders with valid delivery times: ${ordersWithValidTimes}`);
    console.log(`❌ Orders with invalid delivery times: ${ordersWithInvalidTimes}`);
    
    if (ordersWithValidTimes > 0) {
      console.log('\n🎉 CSV parsing test passed!');
      console.log('   Delivery times can be extracted from DoorDash CSV');
    } else {
      console.log('\n❌ CSV parsing test failed!');
      console.log('   No orders with valid delivery times found');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testCsvParsing();


