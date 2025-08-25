#!/usr/bin/env node

// Test invitation flow with current configuration
require('dotenv').config();

console.log('🎯 Testing Invitation Flow with Current Configuration\n');

// Check environment variables
const brevoApiKey = process.env.BREVO_API_KEY;
const crazytelApiKey = process.env.CRAZYTEL_API_KEY;
const crazytelFromNumber = process.env.CRAZYTEL_FROM_NUMBER;

console.log('📋 Current Configuration:');
console.log(`   BREVO_API_KEY: ${brevoApiKey ? '✅ Set' : '❌ Missing'}`);
console.log(`   CRAZYTEL_API_KEY: ${crazytelApiKey ? '✅ Set' : '❌ Missing'}`);
console.log(`   CRAZYTEL_FROM_NUMBER: ${crazytelFromNumber ? '✅ Set' : '❌ Missing'}`);
console.log('');

// Test Brevo email sending
async function testBrevoEmail() {
  console.log('📧 Testing Brevo Email Sending...');
  
  if (!brevoApiKey || brevoApiKey === 'your_brevo_api_key_here') {
    console.log('   ❌ Brevo API key not configured');
    return false;
  }

  try {
    const brevo = require('@getbrevo/brevo');
    const transactionalEmailsApi = new brevo.TransactionalEmailsApi();
    transactionalEmailsApi.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, brevoApiKey);

    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: 'test@example.com' }];
    sendSmtpEmail.subject = 'Test Invitation - Let My People Grow';
    sendSmtpEmail.htmlContent = `
      <h1>Test Invitation</h1>
      <p>This is a test invitation email from Let My People Grow.</p>
      <p>If you receive this, the email service is working correctly!</p>
    `;
    sendSmtpEmail.sender = { 
      email: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au',
      name: process.env.EMAIL_FROM_NAME || 'Let My People Grow'
    };

    const response = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('   ✅ Test email sent successfully!');
    console.log(`   📧 Message ID: ${response.messageId || 'N/A'}`);
    return true;
  } catch (error) {
    console.log('   ❌ Failed to send test email');
    console.log(`   🔍 Error: ${error.message}`);
    return false;
  }
}

// Test Crazytel SMS sending
async function testCrazytelSMS() {
  console.log('📱 Testing Crazytel SMS Sending...');
  
  if (!crazytelApiKey || crazytelApiKey === 'your_crazytel_api_key_here') {
    console.log('   ❌ Crazytel API key not configured');
    return false;
  }

  if (!crazytelFromNumber || crazytelFromNumber === 'your_crazytel_from_number_here') {
    console.log('   ❌ Crazytel from number not configured');
    return false;
  }

  try {
    const response = await fetch('https://sms.crazytel.net.au/api/v1/sms/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${crazytelApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: '+61412345678', // Test number
        from: crazytelFromNumber,
        message: 'Test SMS from Let My People Grow - If you receive this, SMS service is working!',
      }),
    });

    const data = await response.json().catch(() => ({}));
    
    if (response.ok) {
      console.log('   ✅ Test SMS sent successfully!');
      console.log(`   📱 Response: ${JSON.stringify(data)}`);
      return true;
    } else {
      console.log('   ❌ Failed to send test SMS');
      console.log(`   📊 Status: ${response.status}`);
      console.log(`   📱 Response: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (error) {
    console.log('   ❌ Failed to send test SMS');
    console.log(`   🔍 Error: ${error.message}`);
    return false;
  }
}

// Main test function
async function runTests() {
  try {
    const emailOk = await testBrevoEmail();
    console.log('');
    const smsOk = await testCrazytelSMS();
    
    console.log('\n🎯 Summary:');
    if (emailOk && smsOk) {
      console.log('   ✅ Both email and SMS services are working!');
      console.log('   📧 Email invitations: Will work');
      console.log('   📱 SMS invitations: Will work');
    } else if (emailOk) {
      console.log('   ⚠️  Email service working, SMS service not working');
      console.log('   📧 Email invitations: Will work');
      console.log('   📱 SMS invitations: Will not work');
    } else if (smsOk) {
      console.log('   ⚠️  SMS service working, Email service not working');
      console.log('   📧 Email invitations: Will not work');
      console.log('   📱 SMS invitations: Will work');
    } else {
      console.log('   ❌ Neither service is working');
      console.log('   📧 Email invitations: Will not work');
      console.log('   📱 SMS invitations: Will not work');
    }
    
    console.log('\n💡 Next Steps:');
    console.log('1. Try sending an invitation from the Users page');
    console.log('2. Check the server logs for invitation debug information');
    console.log('3. Verify the invited user appears in the users list');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

runTests();
