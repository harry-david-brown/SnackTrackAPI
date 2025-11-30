/**
 * Performance comparison: Direct conversion vs offset-based calculation
 * 
 * This tests the performance difference between:
 * 1. Using Intl.DateTimeFormat for each receipt (current approach)
 * 2. Calculating offset once and using simple arithmetic (proposed approach)
 */

// Simulate current approach
function getLocalHourCurrent(utcDate, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false
  });
  return parseInt(formatter.format(utcDate), 10);
}

// Simulate proposed approach (with offset caching)
const offsetCache = new Map();

function getOffsetForDate(utcDate, timezone) {
  // Use a cache key based on date and timezone
  const cacheKey = `${timezone}-${utcDate.toISOString().split('T')[0]}`;
  
  if (offsetCache.has(cacheKey)) {
    return offsetCache.get(cacheKey);
  }
  
  // Calculate offset using Intl (but only once per date)
  const utcTime = utcDate.getTime();
  const localFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  
  const localParts = localFormatter.formatToParts(utcDate);
  const localHour = parseInt(localParts.find(p => p.type === 'hour').value, 10);
  const localMinute = parseInt(localParts.find(p => p.type === 'minute').value, 10);
  
  const utcHour = utcDate.getUTCHours();
  const utcMinute = utcDate.getUTCMinutes();
  
  // Calculate offset in hours (can be fractional due to minutes)
  let offsetHours = localHour - utcHour;
  
  // Handle day boundary crossing
  if (offsetHours > 12) offsetHours -= 24;
  if (offsetHours < -12) offsetHours += 24;
  
  // Adjust for minutes if needed
  const minuteDiff = localMinute - utcMinute;
  if (Math.abs(minuteDiff) > 30) {
    offsetHours += minuteDiff > 0 ? 1 : -1;
  }
  
  offsetCache.set(cacheKey, offsetHours);
  return offsetHours;
}

function getLocalHourProposed(utcDate, timezone) {
  const offset = getOffsetForDate(utcDate, timezone);
  let localHour = utcDate.getUTCHours() + offset;
  
  // Handle day boundary
  if (localHour < 0) localHour += 24;
  if (localHour >= 24) localHour -= 24;
  
  return localHour;
}

// Generate test data: 1000 receipts at random UTC times
const testReceipts = [];
for (let i = 0; i < 1000; i++) {
  const randomDate = new Date(2024, Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1, Math.floor(Math.random() * 24), Math.floor(Math.random() * 60));
  testReceipts.push(randomDate);
}

const timezone = 'America/New_York'; // EST/EDT (has DST)

console.log('🧪 Performance Test: Timezone Conversion Methods\n');
console.log(`Testing with ${testReceipts.length} receipts in timezone: ${timezone}\n`);

// Test current approach
console.log('1. Current Approach (Intl.DateTimeFormat for each receipt):');
const start1 = performance.now();
const results1 = testReceipts.map(date => getLocalHourCurrent(date, timezone));
const time1 = performance.now() - start1;
console.log(`   Time: ${time1.toFixed(2)}ms`);
console.log(`   Average: ${(time1 / testReceipts.length).toFixed(4)}ms per receipt`);
console.log(`   Sample results: ${results1.slice(0, 5).join(', ')}...\n`);

// Test proposed approach
console.log('2. Proposed Approach (Offset-based with caching):');
const start2 = performance.now();
const results2 = testReceipts.map(date => getLocalHourProposed(date, timezone));
const time2 = performance.now() - start2;
console.log(`   Time: ${time2.toFixed(2)}ms`);
console.log(`   Average: ${(time2 / testReceipts.length).toFixed(4)}ms per receipt`);
console.log(`   Cache size: ${offsetCache.size} entries`);
console.log(`   Sample results: ${results2.slice(0, 5).join(', ')}...\n`);

// Verify results match
const matches = results1.every((val, idx) => val === results2[idx]);
console.log(`3. Verification:`);
console.log(`   Results match: ${matches ? '✅ YES' : '❌ NO'}`);
if (!matches) {
  const mismatches = results1.map((val, idx) => val !== results2[idx] ? idx : -1).filter(i => i >= 0);
  console.log(`   Mismatches at indices: ${mismatches.slice(0, 10).join(', ')}...`);
}

// Calculate speedup
const speedup = (time1 / time2).toFixed(2);
console.log(`\n4. Performance Improvement:`);
console.log(`   Speedup: ${speedup}x faster`);
console.log(`   Time saved: ${(time1 - time2).toFixed(2)}ms for ${testReceipts.length} receipts`);

// Estimate for larger datasets
console.log(`\n5. Projected Performance (10,000 receipts):`);
console.log(`   Current: ~${(time1 * 10).toFixed(0)}ms`);
console.log(`   Proposed: ~${(time2 * 10).toFixed(0)}ms`);
console.log(`   Savings: ~${((time1 - time2) * 10).toFixed(0)}ms`);

console.log(`\n6. Complexity Analysis:`);
console.log(`   Current: Simple, uses built-in Intl API (handles DST automatically)`);
console.log(`   Proposed: More complex, requires offset caching and day boundary handling`);
console.log(`   DST Handling: Current ✅ Automatic | Proposed ⚠️  Requires date-aware offset calculation`);

