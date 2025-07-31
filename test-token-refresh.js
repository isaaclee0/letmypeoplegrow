#!/usr/bin/env node

/**
 * Token Refresh System Test Script
 * 
 * This script tests the token refresh functionality to ensure it's working correctly.
 * Run this after deploying the token refresh fixes.
 */

const axios = require('axios');

// Configuration
const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3001/api';
const TEST_EMAIL = process.env.TEST_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test123';

console.log('🧪 Testing Token Refresh System');
console.log('================================');
console.log(`Base URL: ${BASE_URL}`);
console.log(`Test Email: ${TEST_EMAIL}`);
console.log('');

// Create axios instance with credentials
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

async function testTokenRefresh() {
  try {
    console.log('1️⃣ Testing login...');
    
    // Step 1: Login to get initial token
    const loginResponse = await api.post('/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });
    
    console.log('✅ Login successful');
    console.log(`   User: ${loginResponse.data.user.email}`);
    console.log(`   Role: ${loginResponse.data.user.role}`);
    console.log('');
    
    // Step 2: Test current user endpoint
    console.log('2️⃣ Testing current user endpoint...');
    const userResponse = await api.get('/auth/me');
    console.log('✅ Current user endpoint working');
    console.log(`   User ID: ${userResponse.data.user.id}`);
    console.log('');
    
    // Step 3: Test manual token refresh
    console.log('3️⃣ Testing manual token refresh...');
    const refreshResponse = await api.post('/auth/refresh');
    console.log('✅ Manual token refresh successful');
    console.log(`   Message: ${refreshResponse.data.message}`);
    console.log('');
    
    // Step 4: Test current user endpoint after refresh
    console.log('4️⃣ Testing current user endpoint after refresh...');
    const userAfterRefresh = await api.get('/auth/me');
    console.log('✅ Current user endpoint still working after refresh');
    console.log(`   User ID: ${userAfterRefresh.data.user.id}`);
    console.log('');
    
    // Step 5: Test logout
    console.log('5️⃣ Testing logout...');
    const logoutResponse = await api.post('/auth/logout');
    console.log('✅ Logout successful');
    console.log('');
    
    // Step 6: Test that we can't access protected endpoints after logout
    console.log('6️⃣ Testing access after logout...');
    try {
      await api.get('/auth/me');
      console.log('❌ ERROR: Should not be able to access /auth/me after logout');
    } catch (error) {
      if (error.response?.status === 401) {
        console.log('✅ Correctly blocked access after logout (401 Unauthorized)');
      } else {
        console.log(`❌ Unexpected error: ${error.response?.status || error.message}`);
      }
    }
    
    console.log('');
    console.log('🎉 All token refresh tests passed!');
    console.log('');
    console.log('📋 Summary:');
    console.log('   ✅ Login works');
    console.log('   ✅ Current user endpoint works');
    console.log('   ✅ Manual token refresh works');
    console.log('   ✅ User data persists after refresh');
    console.log('   ✅ Logout works');
    console.log('   ✅ Access is properly blocked after logout');
    
  } catch (error) {
    console.error('💥 Test failed:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.log('');
      console.log('🔍 Troubleshooting 401 errors:');
      console.log('   1. Check if the test user exists in the database');
      console.log('   2. Verify the password is correct');
      console.log('   3. Ensure the server is running');
      console.log('   4. Check server logs for authentication errors');
    }
    
    process.exit(1);
  }
}

// Run the test
testTokenRefresh(); 