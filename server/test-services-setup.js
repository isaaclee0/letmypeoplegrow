#!/usr/bin/env node

// Test script to verify Brevo and Crazytel setup
require('dotenv').config();

console.log('🧪 Testing Email & SMS Service Configuration\n');

// Check environment variables
const brevoApiKey = process.env.BREVO_API_KEY;
const crazytelApiKey = process.env.CRAZYTEL_API_KEY;
const crazytelFromNumber = process.env.CRAZYTEL_FROM_NUMBER;

console.log('📋 Environment Variables Check:');
console.log(`BREVO_API_KEY: ${brevoApiKey ? '✅ Set' : '❌ Missing'}`);
console.log(`CRAZYTEL_API_KEY: ${crazytelApiKey ? '✅ Set' : '❌ Missing'}`);
console.log(`CRAZYTEL_FROM_NUMBER: ${crazytelFromNumber ? '✅ Set' : '❌ Missing'}`);
console.log('');

// Test Brevo configuration
async function testBrevo() {
  console.log('📧 Testing Brevo Email Service...');
  
  if (!brevoApiKey || brevoApiKey === 'your_brevo_api_key_here') {
    console.log('   ❌ Brevo API key not configured');
    console.log('   💡 Add your Brevo API key to server/.env');
    return false;
  }

  if (!brevoApiKey.startsWith('xkeysib-')) {
    console.log('   ❌ Invalid Brevo API key format');
    console.log('   💡 API key should start with "xkeysib-"');
    return false;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/account', {
      headers: {
        'api-key': brevoApiKey
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log('   ✅ Brevo API key is valid!');
      console.log(`   📧 Account email: ${data.email || 'N/A'}`);
      return true;
    } else {
      console.log('   ❌ Brevo API key is invalid');
      console.log(`   📊 Status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.log('   ❌ Failed to connect to Brevo API');
    console.log(`   🔍 Error: ${error.message}`);
    return false;
  }
}

// Test Crazytel configuration
async function testCrazytel() {
  console.log('📱 Testing Crazytel SMS Service...');
  
  if (!crazytelApiKey || crazytelApiKey === 'your_crazytel_api_key_here') {
    console.log('   ❌ Crazytel API key not configured');
    console.log('   💡 Add your Crazytel API key to server/.env');
    return false;
  }

  if (!crazytelFromNumber || crazytelFromNumber === 'your_crazytel_from_number_here') {
    console.log('   ❌ Crazytel from number not configured');
    console.log('   💡 Add your Crazytel from number to server/.env');
    return false;
  }

  console.log('   ✅ Crazytel configuration appears valid');
  console.log(`   📱 From number: ${crazytelFromNumber}`);
  console.log('   💡 Note: Full SMS testing requires a valid recipient number');
  return true;
}

// Test invitation functionality
async function testInvitationFlow() {
  console.log('\n🎯 Testing Invitation Flow...');
  
  const brevoOk = await testBrevo();
  const crazytelOk = await testCrazytel();
  
  if (brevoOk && crazytelOk) {
    console.log('   ✅ Both services configured - invitations will work!');
    console.log('   📧 Email invitations: Available');
    console.log('   📱 SMS invitations: Available');
  } else if (brevoOk) {
    console.log('   ⚠️  Email only configured');
    console.log('   📧 Email invitations: Available');
    console.log('   📱 SMS invitations: Not available');
  } else if (crazytelOk) {
    console.log('   ⚠️  SMS only configured');
    console.log('   📧 Email invitations: Not available');
    console.log('   📱 SMS invitations: Available');
  } else {
    console.log('   ❌ No services configured');
    console.log('   📧 Email invitations: Not available');
    console.log('   📱 SMS invitations: Not available');
    console.log('   💡 Configure at least one service for invitations to work');
  }
}

// Main test function
async function runTests() {
  try {
    await testInvitationFlow();
    
    console.log('\n📚 Next Steps:');
    console.log('1. If services are not configured, follow the EMAIL_SMS_SETUP_GUIDE.md');
    console.log('2. Update server/.env with your API keys');
    console.log('3. Restart the development server: docker-compose -f docker-compose.dev.yml restart server');
    console.log('4. Test invitation sending from the Users page');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

runTests();
