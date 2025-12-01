/**
 * Test Script for Receipt Extraction System
 * 
 * Usage: npx ts-node scripts/test-extraction.ts [path-to-json]
 * 
 * Tests the extraction system against real email data
 */

import * as fs from 'fs';
import * as path from 'path';
import { 
  ReceiptExtractor, 
  RawEmail, 
  ExtractionResult,
  Currency
} from '../src/services/extraction';

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

function log(color: keyof typeof colors, message: string): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function formatCurrency(amount: number | null, currency: Currency): string {
  if (amount === null) return 'N/A';
  const symbols: Record<Currency, string> = {
    [Currency.CAD]: 'CA$',
    [Currency.USD]: '$',
    [Currency.EUR]: '€',
    [Currency.GBP]: '£',
    [Currency.UNKNOWN]: '$'
  };
  return `${symbols[currency]}${amount.toFixed(2)}`;
}

async function main(): Promise<void> {
  // Get JSON file path from args or use default
  const jsonPath = process.argv[2] || path.join(
    __dirname, 
    '../debug/gmail-emails-eb784401-3ea1-4086-8bb1-8fb73c62bef6-2025-11-30T06-52-51-205Z.json'
  );

  log('bright', '\n📧 Receipt Extraction System Test\n');
  log('cyan', `Loading emails from: ${jsonPath}\n`);

  // Load JSON
  if (!fs.existsSync(jsonPath)) {
    log('red', `❌ File not found: ${jsonPath}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(jsonPath, 'utf-8');
  let emails: RawEmail[];
  
  try {
    const parsed = JSON.parse(rawData);
    emails = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    log('red', `❌ Failed to parse JSON: ${error}`);
    process.exit(1);
  }

  log('blue', `Found ${emails.length} emails to process\n`);

  // Create extractor
  const extractor = new ReceiptExtractor();

  // Process each email
  const results: ExtractionResult[] = [];
  let receiptCount = 0;
  let nonReceiptCount = 0;

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const result = extractor.extract(email);
    results.push(result);

    const idx = `[${i + 1}/${emails.length}]`;
    
    if (result.classification.isReceipt) {
      receiptCount++;
      const data = result.data!;
      
      log('green', `${idx} ✅ RECEIPT DETECTED`);
      console.log(`    Subject: ${email.subject || 'N/A'}`);
      console.log(`    Merchant: ${data.merchant || 'Unknown'}`);
      console.log(`    Total: ${formatCurrency(data.total, data.currency)}`);
      console.log(`    Date: ${data.orderDate || 'N/A'} ${data.orderTime || ''}`);
      
      if (data.subtotal) console.log(`    Subtotal: ${formatCurrency(data.subtotal, data.currency)}`);
      if (data.tax) console.log(`    Tax: ${formatCurrency(data.tax, data.currency)}`);
      if (data.tip) console.log(`    Tip: ${formatCurrency(data.tip, data.currency)}`);
      if (data.deliveryFee) console.log(`    Delivery: ${formatCurrency(data.deliveryFee, data.currency)}`);
      if (data.savings) console.log(`    Savings: ${formatCurrency(data.savings, data.currency)}`);
      
      console.log(`    Confidence: ${(result.classification.confidence * 100).toFixed(0)}%`);
      if (data.warnings.length > 0) {
        log('yellow', `    ⚠️  Warnings: ${data.warnings.join(', ')}`);
      }
    } else {
      nonReceiptCount++;
      log('yellow', `${idx} ⏭️  NOT A RECEIPT`);
      console.log(`    Subject: ${email.subject || 'N/A'}`);
      console.log(`    Reason: ${result.classification.reason}`);
    }
    console.log();
  }

  // Print summary
  log('bright', '═══════════════════════════════════════════════════════');
  log('bright', '                    EXTRACTION SUMMARY                  ');
  log('bright', '═══════════════════════════════════════════════════════\n');

  const summary = extractor.getSummary(results);

  console.log(`  📊 Total Emails Processed: ${emails.length}`);
  console.log(`  ✅ Receipts Found: ${receiptCount}`);
  console.log(`  ⏭️  Non-Receipts: ${nonReceiptCount}`);
  console.log();
  
  if (summary.totalReceipts > 0) {
    log('cyan', '  💰 Financial Summary:');
    console.log(`     Total Spent: ${formatCurrency(summary.totalAmount, Currency.CAD)}`);
    console.log(`     Average Order: ${formatCurrency(summary.averageOrderAmount, Currency.CAD)}`);
    console.log(`     Total Tax: ${formatCurrency(summary.totalTax, Currency.CAD)}`);
    console.log(`     Total Tips: ${formatCurrency(summary.totalTip, Currency.CAD)}`);
    console.log(`     Total Delivery Fees: ${formatCurrency(summary.totalDeliveryFees, Currency.CAD)}`);
    console.log(`     Total Savings: ${formatCurrency(summary.totalSavings, Currency.CAD)}`);
    console.log();

    if (summary.topMerchants.length > 0) {
      log('magenta', '  🏪 Top Merchants:');
      summary.topMerchants.forEach((m, i) => {
        console.log(`     ${i + 1}. ${m.name} (${m.count} orders)`);
      });
      console.log();
    }

    if (summary.dateRange.earliest && summary.dateRange.latest) {
      log('blue', '  📅 Date Range:');
      console.log(`     Earliest: ${summary.dateRange.earliest.toLocaleDateString()}`);
      console.log(`     Latest: ${summary.dateRange.latest.toLocaleDateString()}`);
    }
  }

  console.log();
  log('green', '✅ Extraction test complete!\n');
}

main().catch(console.error);

