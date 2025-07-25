require('dotenv').config();
const brevo = require('@getbrevo/brevo');

async function testBrevoDetailed() {
  console.log('🔍 Detailed Brevo API Test\n');
  
  // Check API key
  const apiKey = process.env.BREVO_API_KEY;
  console.log('1. Checking API key...');
  console.log(`   API Key exists: ${apiKey ? '✅ YES' : '❌ NO'}`);
  if (apiKey) {
    console.log(`   API Key length: ${apiKey.length} characters`);
    console.log(`   API Key starts with: ${apiKey.substring(0, 10)}...`);
    console.log(`   API Key format looks correct: ${apiKey.startsWith('xkeysib-') ? '✅ YES' : '❌ NO'}`);
  }
  console.log('');
  
  // Test basic connectivity
  console.log('2. Testing basic connectivity...');
  try {
    const accountApi = new brevo.AccountApi();
    accountApi.setApiKey(brevo.AccountApiApiKeys.apiKey, apiKey);
    
    console.log('   Attempting to call Brevo API...');
    const account = await accountApi.getAccount();
    console.log('   ✅ API call successful!');
    console.log(`   Account email: ${account.email}`);
    console.log(`   Account first name: ${account.firstName}`);
    console.log(`   Account last name: ${account.lastName}`);
    
  } catch (error) {
    console.log('   ❌ API call failed:');
    console.log(`   Error type: ${error.constructor.name}`);
    console.log(`   Error message: ${error.message}`);
    
    if (error.response) {
      console.log(`   HTTP Status: ${error.response.status}`);
      console.log(`   HTTP Status Text: ${error.response.statusText}`);
      console.log(`   Response data:`, error.response.data);
    }
    
    if (error.code) {
      console.log(`   Error code: ${error.code}`);
    }
  }
  console.log('');
  
  // Test sending email directly
  console.log('3. Testing email sending...');
  try {
    const transactionalEmailsApi = new brevo.TransactionalEmailsApi();
    transactionalEmailsApi.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);
    
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.subject = 'Test Email from Let My People Grow';
    sendSmtpEmail.htmlContent = '<h1>Test Email</h1><p>This is a test email to verify Brevo configuration.</p>';
    sendSmtpEmail.textContent = 'Test Email\n\nThis is a test email to verify Brevo configuration.';
    sendSmtpEmail.sender = { 
      name: 'Let My People Grow Test', 
      email: process.env.EMAIL_FROM || 'noreply@redeemercc.org.au'
    };
    sendSmtpEmail.to = [{ email: 'isaac@leemail.com.au' }];
    
    console.log('   Attempting to send test email...');
    const result = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('   ✅ Email sent successfully!');
    console.log(`   Message ID: ${result.messageId}`);
    
  } catch (error) {
    console.log('   ❌ Email sending failed:');
    console.log(`   Error type: ${error.constructor.name}`);
    console.log(`   Error message: ${error.message}`);
    
    if (error.response) {
      console.log(`   HTTP Status: ${error.response.status}`);
      console.log(`   HTTP Status Text: ${error.response.statusText}`);
      console.log(`   Response data:`, error.response.data);
    }
  }
}

testBrevoDetailed().catch(console.error); 