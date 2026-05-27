/**
 * Gmail Integration Example
 * 
 * This script demonstrates how to:
 * 1. Register/Login a user
 * 2. Connect Gmail account
 * 3. Import Uber Eats receipts from Gmail
 * 4. View imported receipts
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function main() {
  console.log('🥡 SnackTrack Gmail Integration Demo\n');

  // Step 1: Register or Login
  console.log('📝 Step 1: User Authentication');
  const email = 'demo@example.com';
  const password = 'Demo123456!';

  let accessToken;
  
  try {
    // Try to login first
    const loginResponse = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (loginResponse.ok) {
      const data = await loginResponse.json();
      accessToken = data.accessToken;
      console.log('✅ Logged in successfully');
    } else {
      // If login fails, try to register
      console.log('⚠️  Login failed, trying to register...');
      const registerResponse = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!registerResponse.ok) {
        throw new Error('Failed to register: ' + await registerResponse.text());
      }

      const data = await registerResponse.json();
      accessToken = data.accessToken;
      console.log('✅ Registered successfully');
    }
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    return;
  }

  console.log('   Access Token:', accessToken.substring(0, 20) + '...\n');

  // Step 2: Check Gmail connection status
  console.log('📧 Step 2: Check Gmail Connection');
  try {
    const statusResponse = await fetch(`${BASE_URL}/gmail/status`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!statusResponse.ok) {
      throw new Error('Failed to check status: ' + await statusResponse.text());
    }

    const status = await statusResponse.json();
    console.log('   Gmail Connected:', status.connected);
    console.log('   Email:', status.email);
    console.log('   Can Import:', status.canImport);
    console.log('   Needs Reconnect:', status.needsReconnect);

    if (!status.connected) {
      console.log('\n⚠️  Gmail not connected.');
      console.log('   Complete the Gmail OAuth flow from the SnackTrack frontend first,');
      console.log('   then re-run this script.\n');
      return;
    }

    if (!status.canImport) {
      console.log('\n⚠️  Gmail is connected but not import-ready.');
      console.log('   Status:', status.statusMessage || 'Reconnect Gmail from the frontend.');
      return;
    }

    console.log('✅ Gmail is connected!\n');
  } catch (error) {
    console.error('❌ Failed to check Gmail status:', error.message);
    return;
  }

  // Step 3: Import receipts from Gmail
  console.log('📥 Step 3: Import Uber Eats Receipts from Gmail');
  try {
    const importResponse = await fetch(`${BASE_URL}/gmail/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replaceExisting: false // Don't delete existing email-based receipts
      })
    });

    if (!importResponse.ok) {
      throw new Error('Failed to import: ' + await importResponse.text());
    }

    const result = await importResponse.json();
    console.log('   Total Emails Found:', result.totalEmailsFound);
    console.log('   Receipts Processed:', result.totalReceiptsProcessed);
    console.log('   Receipts Imported:', result.totalReceiptsImported);
    console.log('   Total Amount: $' + result.totalAmount.toFixed(2));
    
    if (result.errors && result.errors.length > 0) {
      console.log('   Errors:', result.errors);
    }

    console.log('✅ Import completed!\n');
  } catch (error) {
    console.error('❌ Failed to import receipts:', error.message);
    return;
  }

  // Step 4: View imported receipts
  console.log('📊 Step 4: View Imported Receipts');
  try {
    // First, get the user ID from the access token
    // In a real app, you'd decode the JWT or get it from the login response
    // For this demo, we'll fetch the user's receipts directly
    
    const userResponse = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    let userId;
    if (userResponse.ok) {
      const userData = await userResponse.json();
      userId = userData.userId;
    } else {
      // If /auth/me doesn't exist, we'll need to get userId another way
      console.log('   Note: Unable to get user ID. Using receipts endpoint with email filter...');
      
      // Try to get receipts (this might fail if userId is required)
      const receiptsResponse = await fetch(
        `${BASE_URL}/receipts?limit=5`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );

      if (!receiptsResponse.ok) {
        console.log('   ⚠️  Could not fetch receipts. You may need to query with userId parameter.');
        return;
      }

      const receiptsData = await receiptsResponse.json();
      console.log('   Total Receipts:', receiptsData.pagination?.total || receiptsData.receipts?.length);
      
      if (receiptsData.receipts && receiptsData.receipts.length > 0) {
        console.log('   Sample receipts:');
        receiptsData.receipts.slice(0, 3).forEach((receipt, i) => {
          console.log(`   ${i + 1}. ${receipt.restaurantName || 'Unknown'} - $${receipt.amountSpent} (${receipt.dataSource})`);
        });
      }
    }

    console.log('✅ Done!\n');
  } catch (error) {
    console.error('❌ Failed to view receipts:', error.message);
  }

  // Summary
  console.log('🎉 Gmail Integration Demo Complete!');
  console.log('   You can now:');
  console.log('   - View all receipts: GET /receipts');
  console.log('   - Get analytics: GET /users/:id/summary');
  console.log('   - Import again: POST /gmail/import');
  console.log('   - Disconnect Gmail: POST /gmail/disconnect');
}

// Run the demo
main().catch(console.error);
