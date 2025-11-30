/**
 * Test script to verify UTC receipt times are correctly converted to user's local timezone
 * 
 * This verifies that when we have a UTC receipt time, we correctly convert it to the user's
 * timezone before checking if it falls in the 12am-6am range.
 */

// Simulate the getLocalHour function
function getLocalHour(utcDate, timezone = 'America/New_York') {
  if (!utcDate) return null;
  
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false
  });
  
  const hour = parseInt(formatter.format(utcDate), 10);
  return hour;
}

// Test cases
console.log('🧪 Testing UTC to Local Timezone Conversion\n');

// Test 1: A receipt at 3am UTC should be converted to local time
// If user is in EST (UTC-5), 3am UTC = 10pm EST (previous day)
// If user is in PST (UTC-8), 3am UTC = 7pm PST (previous day)
// If user is in London (UTC+0), 3am UTC = 3am GMT

const testCases = [
  {
    name: 'Receipt at 3:00 AM UTC',
    utcDate: new Date('2025-01-15T03:00:00Z'), // 3am UTC
    timezones: [
      { tz: 'America/New_York', expected: '10pm (22) previous day' },
      { tz: 'America/Los_Angeles', expected: '7pm (19) previous day' },
      { tz: 'Europe/London', expected: '3am (3) same day' },
      { tz: 'Asia/Tokyo', expected: '12pm (12) same day' }
    ]
  },
  {
    name: 'Receipt at 1:00 AM UTC',
    utcDate: new Date('2025-01-15T01:00:00Z'), // 1am UTC
    timezones: [
      { tz: 'America/New_York', expected: '8pm (20) previous day' },
      { tz: 'America/Los_Angeles', expected: '5pm (17) previous day' },
      { tz: 'Europe/London', expected: '1am (1) same day' }
    ]
  },
  {
    name: 'Receipt at 5:00 AM UTC',
    utcDate: new Date('2025-01-15T05:00:00Z'), // 5am UTC
    timezones: [
      { tz: 'America/New_York', expected: '12am (0) same day' },
      { tz: 'America/Los_Angeles', expected: '9pm (21) previous day' },
      { tz: 'Europe/London', expected: '5am (5) same day' }
    ]
  }
];

testCases.forEach(testCase => {
  console.log(`\n📅 ${testCase.name}`);
  console.log(`   UTC Time: ${testCase.utcDate.toISOString()}`);
  
  testCase.timezones.forEach(({ tz, expected }) => {
    const localHour = getLocalHour(testCase.utcDate, tz);
    const isLateNight = localHour !== null && localHour >= 0 && localHour < 6;
    
    console.log(`   ${tz}:`);
    console.log(`     Local Hour: ${localHour} (expected: ${expected})`);
    console.log(`     Is Late Night (0-6am)? ${isLateNight ? '✅ YES' : '❌ NO'}`);
  });
});

// Test 2: Verify that "3am regret" calculation works correctly
console.log('\n\n🎯 Testing "3am Regret" Calculation Logic\n');

const receipts = [
  { id: '1', orderDate: new Date('2025-01-15T03:00:00Z'), amount: 25.50 }, // 3am UTC
  { id: '2', orderDate: new Date('2025-01-15T05:30:00Z'), amount: 18.00 }, // 5:30am UTC
  { id: '3', orderDate: new Date('2025-01-15T10:00:00Z'), amount: 30.00 }, // 10am UTC
  { id: '4', orderDate: new Date('2025-01-15T23:00:00Z'), amount: 22.00 }, // 11pm UTC
];

console.log('Receipts (all in UTC):');
receipts.forEach(r => {
  console.log(`  ${r.id}: ${r.orderDate.toISOString()} - $${r.amount}`);
});

// Test for different timezones
['America/New_York', 'Europe/London', 'Asia/Tokyo'].forEach(timezone => {
  console.log(`\n📍 Timezone: ${timezone}`);
  
  const lateNightReceipts = receipts.filter(r => {
    const hour = getLocalHour(r.orderDate, timezone);
    return hour !== null && hour >= 0 && hour < 6;
  });
  
  console.log(`   Late Night Receipts (0-6am local time): ${lateNightReceipts.length}`);
  lateNightReceipts.forEach(r => {
    const localHour = getLocalHour(r.orderDate, timezone);
    console.log(`     - Receipt ${r.id}: ${r.orderDate.toISOString()} → ${localHour}:00 local time - $${r.amount}`);
  });
});

console.log('\n✅ Test completed!');

