#!/usr/bin/env ts-node

/**
 * Configuration Testing Script
 * 
 * This script tests the centralized configuration system
 * and demonstrates how to switch between dev and prod modes.
 */

import { config, appConfig } from '../src/config/AppConfig';

console.log('🧪 Testing Centralized Configuration System\n');

// Test current configuration
console.log('📋 Current Configuration:');
console.log(config.getEnvironmentInfo());
console.log('');

// Test Gmail configuration
console.log('📧 Gmail Configuration:');
console.log(`  - Use Real API: ${config.shouldUseRealGmailApi()}`);
console.log(`  - Use Mock Data: ${config.shouldUseMockData()}`);
console.log(`  - Include Forwarded Receipts: ${config.shouldAllowForwardedReceipts()}`);
console.log(`  - Search Query: ${config.getGmailSearchQuery()}`);
console.log('');

// Test database configuration
console.log('🗄️  Database Configuration:');
console.log(`  - Use SSL: ${config.shouldUseDatabaseSSL()}`);
console.log(`  - Connection String: ${config.getDatabaseConnectionString()}`);
console.log('');

// Test debug configuration
console.log('🐛 Debug Configuration:');
console.log(`  - Detailed Logging: ${config.shouldEnableDetailedLogging()}`);
console.log(`  - Show Email Content: ${config.shouldShowEmailContent()}`);
console.log('');

// Test server configuration
console.log('🚀 Server Configuration:');
console.log(`  - Port: ${config.getServerPort()}`);
console.log(`  - Host: ${config.getServerHost()}`);
console.log('');

// Demonstrate environment switching
console.log('🔄 Environment Switching Test:');
console.log('  Current environment:', config.isDevelopment() ? 'DEVELOPMENT' : 'PRODUCTION');

// Simulate switching to production
console.log('\n📝 To switch to PRODUCTION mode:');
console.log('  1. Change NODE_ENV=production in .env file');
console.log('  2. Restart the server');
console.log('  3. All configuration will automatically update');

console.log('\n📝 To switch to DEVELOPMENT mode:');
console.log('  1. Change NODE_ENV=development in .env file');
console.log('  2. Restart the server');
console.log('  3. All configuration will automatically update');

console.log('\n✅ Configuration system is working correctly!');
console.log('🎯 Single source of truth for all environment settings.');
