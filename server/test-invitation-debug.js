const axios = require('axios');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001/api';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PHONE = process.env.TEST_PHONE || '+61412345678';

// Test scenarios
const testScenarios = [
  {
    name: 'Valid Email Invitation',
    data: {
      email: TEST_EMAIL,
      primaryContactMethod: 'email',
      role: 'attendance_taker',
      firstName: 'Test',
      lastName: 'User',
      gatheringIds: []
    }
  },
  {
    name: 'Valid SMS Invitation',
    data: {
      mobileNumber: TEST_PHONE,
      primaryContactMethod: 'sms',
      role: 'coordinator',
      firstName: 'Test',
      lastName: 'Coordinator',
      gatheringIds: []
    }
  },
  {
    name: 'Invalid Email Format',
    data: {
      email: 'invalid-email',
      primaryContactMethod: 'email',
      role: 'attendance_taker',
      firstName: 'Test',
      lastName: 'User',
      gatheringIds: []
    }
  },
  {
    name: 'Missing Required Fields',
    data: {
      email: TEST_EMAIL,
      primaryContactMethod: 'email',
      role: 'attendance_taker',
      // Missing firstName and lastName
      gatheringIds: []
    }
  },
  {
    name: 'Coordinator Creating Admin (Should Fail)',
    data: {
      email: TEST_EMAIL,
      primaryContactMethod: 'email',
      role: 'admin',
      firstName: 'Test',
      lastName: 'Admin',
      gatheringIds: []
    }
  }
];

async function testInvitationAPI() {
  console.log('🧪 Starting Invitation API Tests');
  console.log('📍 Base URL:', BASE_URL);
  console.log('📧 Test Email:', TEST_EMAIL);
  console.log('📱 Test Phone:', TEST_PHONE);
  console.log('');

  // First, we need to authenticate (you'll need to provide valid credentials)
  console.log('🔐 Note: You need to provide valid authentication credentials');
  console.log('   Set the Authorization header with a valid JWT token');
  console.log('');

  for (const scenario of testScenarios) {
    console.log(`🧪 Testing: ${scenario.name}`);
    console.log('📤 Request Data:', JSON.stringify(scenario.data, null, 2));
    
    try {
      const response = await axios.post(`${BASE_URL}/invitations/send`, scenario.data, {
        headers: {
          'Content-Type': 'application/json',
          // Add your auth token here
          // 'Authorization': 'Bearer YOUR_JWT_TOKEN'
        },
        timeout: 10000
      });
      
      console.log('✅ Success Response:', {
        status: response.status,
        data: response.data
      });
    } catch (error) {
      console.log('❌ Error Response:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
    }
    
    console.log('─'.repeat(50));
    console.log('');
  }
}

async function testEmailService() {
  console.log('📧 Testing Email Service Configuration');
  console.log('');
  
  const emailConfig = {
    BREVO_API_KEY: process.env.BREVO_API_KEY ? '✅ Set' : '❌ Not Set',
    EMAIL_FROM: process.env.EMAIL_FROM || '❌ Not Set',
    CHURCH_NAME: process.env.CHURCH_NAME || '❌ Not Set'
  };
  
  console.log('📧 Email Configuration:');
  Object.entries(emailConfig).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });
  console.log('');
}

async function testSMSService() {
  console.log('📱 Testing SMS Service Configuration');
  console.log('');
  
  const smsConfig = {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Not Set',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? '✅ Set' : '❌ Not Set',
    TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '❌ Not Set'
  };
  
  console.log('📱 SMS Configuration:');
  Object.entries(smsConfig).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });
  console.log('');
}

async function testDatabaseConnection() {
  console.log('🗄️ Testing Database Connection');
  console.log('');
  
  const dbConfig = {
    DB_HOST: process.env.DB_HOST || '❌ Not Set',
    DB_PORT: process.env.DB_PORT || '❌ Not Set',
    DB_NAME: process.env.DB_NAME || '❌ Not Set',
    DB_USER: process.env.DB_USER || '❌ Not Set',
    DB_PASSWORD: process.env.DB_PASSWORD ? '✅ Set' : '❌ Not Set'
  };
  
  console.log('🗄️ Database Configuration:');
  Object.entries(dbConfig).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });
  console.log('');
}

async function runAllTests() {
  console.log('🚀 Starting Comprehensive Invitation Debug Tests');
  console.log('='.repeat(60));
  console.log('');
  
  await testDatabaseConnection();
  await testEmailService();
  await testSMSService();
  await testInvitationAPI();
  
  console.log('🏁 All tests completed');
  console.log('');
  console.log('💡 Tips for debugging:');
  console.log('   1. Check the server logs for detailed debug information');
  console.log('   2. Verify all environment variables are set correctly');
  console.log('   3. Ensure the database is accessible and tables exist');
  console.log('   4. Test email/SMS services independently');
  console.log('   5. Use the debug panel in the frontend for real-time logs');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testInvitationAPI,
  testEmailService,
  testSMSService,
  testDatabaseConnection,
  runAllTests
}; 