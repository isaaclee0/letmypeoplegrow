#!/usr/bin/env node

require('dotenv').config();
const twilio = require('twilio');

async function testTwilioAuth() {
  console.log('🔍 Twilio Authentication Diagnostic\n');
  
  const apiKeySid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySecret = process.env.TWILIO_AUTH_TOKEN;
  const mainAccountSid = process.env.TWILIO_MAIN_ACCOUNT_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  
  console.log('📋 Credentials:');
  console.log(`API Key SID: ${apiKeySid}`);
  console.log(`API Key Secret: ${apiKeySecret ? apiKeySecret.substring(0, 8) + '...' : 'Missing'}`);
  console.log(`Main Account SID: ${mainAccountSid}`);
  console.log(`From Number: ${fromNumber}\n`);
  
  // Test 1: Try API Key authentication
  console.log('🧪 Test 1: API Key Authentication');
  try {
    const client = twilio(apiKeySid, apiKeySecret, { accountSid: mainAccountSid });
    
    // Try to get account information
    const account = await client.api.accounts(mainAccountSid).fetch();
    console.log('✅ API Key authentication successful!');
    console.log(`Account Name: ${account.friendlyName}`);
    console.log(`Account Status: ${account.status}`);
    console.log(`Account Type: ${account.type}\n`);
    
    // Test 2: Check phone number ownership
    console.log('🧪 Test 2: Phone Number Verification');
    try {
      const phoneNumbers = await client.incomingPhoneNumbers.list({
        phoneNumber: fromNumber
      });
      
      if (phoneNumbers.length > 0) {
        console.log('✅ Phone number found in account');
        console.log(`Phone Number: ${phoneNumbers[0].phoneNumber}`);
        console.log(`Friendly Name: ${phoneNumbers[0].friendlyName}`);
        console.log(`SMS Enabled: ${phoneNumbers[0].capabilities.sms ? '✅' : '❌'}`);
      } else {
        console.log('❌ Phone number not found in this account');
        console.log('This could be why SMS is failing.');
      }
    } catch (phoneError) {
      console.log('❌ Failed to check phone number:', phoneError.message);
    }
    
    // Test 3: Check API Key permissions
    console.log('\n🧪 Test 3: API Key Permissions');
    try {
      const keys = await client.keys.list({ limit: 20 });
      const currentKey = keys.find(key => key.sid === apiKeySid);
      
      if (currentKey) {
        console.log('✅ API Key found');
        console.log(`Key Name: ${currentKey.friendlyName}`);
        console.log(`Date Created: ${currentKey.dateCreated}`);
      } else {
        console.log('⚠️ Current API Key not found in list (this is normal)');
      }
    } catch (keyError) {
      console.log('⚠️ Could not check API Key details:', keyError.message);
    }
    
    // Test 4: Try sending a simple SMS
    console.log('\n🧪 Test 4: SMS Send Test');
    try {
      const message = await client.messages.create({
        body: 'Test message from Let My People Grow! 🇦🇺 Your login code is: 123456',
        from: fromNumber,
        to: '+61427906691'
      });
      
      console.log('✅ SMS sent successfully!');
      console.log(`Message SID: ${message.sid}`);
      console.log(`Status: ${message.status}`);
      console.log(`Direction: ${message.direction}`);
      console.log('\n📱 Check +61427906691 for the test message!');
      
    } catch (smsError) {
      console.log('❌ SMS send failed:', smsError.message);
      console.log(`Error Code: ${smsError.code}`);
      
      // Provide specific error guidance
      switch (smsError.code) {
        case 20003:
          console.log('💡 Authentication failed - API Key or Account SID issue');
          break;
        case 21211:
          console.log('💡 Invalid "To" phone number');
          break;
        case 21212:
          console.log('💡 Invalid "From" phone number');
          break;
        case 21408:
          console.log('💡 Permission denied - check account status');
          break;
        case 21610:
          console.log('💡 Message cannot be sent to this number');
          break;
        default:
          console.log('💡 Check Twilio console for more details');
      }
    }
    
  } catch (authError) {
    console.log('❌ API Key authentication failed:', authError.message);
    console.log('💡 Possible issues:');
    console.log('  - API Key does not belong to this Account SID');
    console.log('  - API Key has been deactivated');
    console.log('  - Account SID is incorrect');
    console.log('  - API Key does not have sufficient permissions');
  }
}

testTwilioAuth().catch(console.error); 