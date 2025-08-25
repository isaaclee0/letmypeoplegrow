#!/usr/bin/env node

// Mock service test for development
require('dotenv').config();

console.log('🎭 Testing Mock Email & SMS Services (Development Mode)\n');

// Simulate Brevo email service
async function mockBrevoEmail(to, subject, content) {
  console.log('📧 Mock Brevo Email Service:');
  console.log(`   To: ${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Content: ${content.substring(0, 100)}...`);
  console.log('   ✅ Email would be sent (mock mode)');
  return { success: true, messageId: 'mock-' + Date.now() };
}

// Simulate Crazytel SMS service
async function mockCrazytelSMS(to, message) {
  console.log('📱 Mock Crazytel SMS Service:');
  console.log(`   To: ${to}`);
  console.log(`   Message: ${message}`);
  console.log('   ✅ SMS would be sent (mock mode)');
  return { success: true, messageId: 'mock-' + Date.now() };
}

// Test invitation flow with mock services
async function testMockInvitation() {
  console.log('🎯 Testing Mock Invitation Flow...\n');
  
  // Test email invitation
  console.log('1. Testing Email Invitation:');
  await mockBrevoEmail(
    'test@example.com',
    "You're invited to join Let My People Grow!",
    'Hi Test User, you have been invited to join our church management system. Click here to accept: http://localhost:3000/login'
  );
  console.log('');
  
  // Test SMS invitation
  console.log('2. Testing SMS Invitation:');
  await mockCrazytelSMS(
    '+61412345678',
    'Hi Test! You\'re invited to Let My People Grow. Accept: http://localhost:3000/login (7 days)'
  );
  console.log('');
  
  // Test OTC SMS
  console.log('3. Testing OTC SMS:');
  await mockCrazytelSMS(
    '+61412345678',
    'Your Let My People Grow login code is: 123456. Expires in 10 minutes.'
  );
  console.log('');
  
  console.log('✅ All mock services working correctly!');
  console.log('💡 In development mode, these would be real emails/SMS');
}

// Test the current server configuration
async function testServerConfig() {
  console.log('🔧 Current Server Configuration:');
  
  const brevoApiKey = process.env.BREVO_API_KEY;
  const crazytelApiKey = process.env.CRAZYTEL_API_KEY;
  const crazytelFromNumber = process.env.CRAZYTEL_FROM_NUMBER;
  
  console.log(`   BREVO_API_KEY: ${brevoApiKey ? 'Set' : 'Not set'}`);
  console.log(`   CRAZYTEL_API_KEY: ${crazytelApiKey ? 'Set' : 'Not set'}`);
  console.log(`   CRAZYTEL_FROM_NUMBER: ${crazytelFromNumber ? 'Set' : 'Not set'}`);
  
  if (!brevoApiKey || brevoApiKey === 'your_brevo_api_key_here') {
    console.log('   📧 Email: Will use development mode (no real emails sent)');
  } else {
    console.log('   📧 Email: Configured for real sending');
  }
  
  if (!crazytelApiKey || crazytelApiKey === 'your_crazytel_api_key_here') {
    console.log('   📱 SMS: Will use development mode (no real SMS sent)');
  } else {
    console.log('   📱 SMS: Configured for real sending');
  }
  
  console.log('');
}

// Main function
async function main() {
  await testServerConfig();
  await testMockInvitation();
  
  console.log('\n📚 Development Notes:');
  console.log('• The server will work in development mode without real API keys');
  console.log('• Invitations will be created but emails/SMS won\'t be sent');
  console.log('• To enable real sending, follow EMAIL_SMS_SETUP_GUIDE.md');
  console.log('• Test the invitation flow in the Users page');
}

main().catch(console.error);
