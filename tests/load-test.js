/**
 * k6 Load Testing Script
 * 
 * Tests API performance under concurrent load
 * Validates 100-1000+ concurrent users
 * 
 * Install k6: https://k6.io/docs/get-started/installation/
 * Run: k6 run tests/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const authLatency = new Trend('auth_latency');
const analyticsLatency = new Trend('analytics_latency');
const uploadLatency = new Trend('upload_latency');

// Test configuration
export const options = {
  stages: [
    // Warm up
    { duration: '30s', target: 10 },   // Ramp up to 10 users
    
    // Load test
    { duration: '1m', target: 50 },    // Ramp up to 50 users
    { duration: '2m', target: 100 },   // Ramp up to 100 users
    { duration: '3m', target: 100 },   // Stay at 100 users
    
    // Stress test (optional - uncomment for high load)
    // { duration: '2m', target: 500 },   // Ramp to 500 users
    // { duration: '2m', target: 1000 },  // Ramp to 1000 users
    // { duration: '3m', target: 1000 },  // Stay at 1000 users
    
    // Cool down
    { duration: '30s', target: 0 },    // Ramp down to 0
  ],
  
  thresholds: {
    // API should respond within reasonable time
    'http_req_duration': ['p(95)<2000'], // 95% of requests under 2s
    'http_req_duration{endpoint:health}': ['p(95)<100'], // Health check under 100ms
    'http_req_duration{endpoint:analytics}': ['p(95)<500'], // Analytics under 500ms
    
    // Error rate should be low
    'errors': ['rate<0.01'], // Less than 1% errors
    'http_req_failed': ['rate<0.01'], // Less than 1% failed requests
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';

// Test data
let testUsers = [];

export function setup() {
  console.log('Setting up test data...');
  
  // Create 10 test users for load testing
  const users = [];
  for (let i = 0; i < 10; i++) {
    const email = `loadtest-${Date.now()}-${i}@example.com`;
    const password = 'LoadTest123';
    
    const response = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    if (response.status === 201) {
      const body = JSON.parse(response.body);
      users.push({
        userId: body.userId,
        email: body.email,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      });
    }
  }
  
  console.log(`Created ${users.length} test users`);
  return { users };
}

export default function(data) {
  // Pick a random user for this iteration
  const user = data.users[Math.floor(Math.random() * data.users.length)];
  
  if (!user) {
    console.error('No test users available');
    return;
  }

  // Test scenario weights
  const scenario = Math.random();
  
  if (scenario < 0.3) {
    // 30%: Health check (lightweight)
    testHealthCheck();
  } else if (scenario < 0.7) {
    // 40%: Analytics request (most common user action)
    testAnalytics(user);
  } else if (scenario < 0.9) {
    // 20%: Login (simulates new sessions)
    testLogin(user);
  } else {
    // 10%: Token refresh
    testTokenRefresh(user);
  }
  
  // Random sleep between requests (0.5-2s)
  sleep(Math.random() * 1.5 + 0.5);
}

function testHealthCheck() {
  const response = http.get(`${BASE_URL}/health`, {
    tags: { endpoint: 'health' }
  });
  
  const success = check(response, {
    'health check is 200': (r) => r.status === 200,
    'health check has status': (r) => JSON.parse(r.body).status === 'ok',
  });
  
  errorRate.add(!success);
}

function testAnalytics(user) {
  const response = http.get(
    `${BASE_URL}/users/${user.userId}/summary`,
    {
      headers: { 'Authorization': `Bearer ${user.accessToken}` },
      tags: { endpoint: 'analytics' }
    }
  );
  
  const success = check(response, {
    'analytics is 200': (r) => r.status === 200,
    'analytics has statistics': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.statistics !== undefined;
      } catch {
        return false;
      }
    },
  });
  
  if (success) {
    analyticsLatency.add(response.timings.duration);
  }
  
  errorRate.add(!success);
}

function testLogin(user) {
  const response = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: user.email,
      password: 'LoadTest123'
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { endpoint: 'login' }
    }
  );
  
  const success = check(response, {
    'login is 200': (r) => r.status === 200,
    'login returns token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.accessToken !== undefined;
      } catch {
        return false;
      }
    },
  });
  
  if (success) {
    authLatency.add(response.timings.duration);
  }
  
  errorRate.add(!success);
}

function testTokenRefresh(user) {
  const response = http.post(
    `${BASE_URL}/auth/refresh`,
    JSON.stringify({
      refreshToken: user.refreshToken
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { endpoint: 'refresh' }
    }
  );
  
  const success = check(response, {
    'refresh is 200': (r) => r.status === 200,
    'refresh returns new token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.accessToken !== undefined;
      } catch {
        return false;
      }
    },
  });
  
  errorRate.add(!success);
}

export function teardown(data) {
  console.log('Load test complete!');
  console.log(`Tested with ${data.users.length} users`);
}

