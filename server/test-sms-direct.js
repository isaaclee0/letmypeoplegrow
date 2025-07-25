#!/usr/bin/env node

// Direct SMS test script - bypasses auth and database
require('dotenv').config();
const twilio = require('twilio');
const { parsePhoneNumberSmart } = require('./utils/phoneNumber');

async function testSMS() {
  console.log('🧪 Direct SMS Test to +61427906691\n');
  
  // Check environment variables
  const apiKeySid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySecret = process.env.TWILIO_AUTH_TOKEN;
  const mainAccountSid = process.env.TWILIO_MAIN_ACCOUNT_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  
  console.log('📋 Configuration Check:');
  console.log(`TWILIO_ACCOUNT_SID (API Key): ${apiKeySid ? '✅ Set' : '❌ Missing'}`);
  console.log(`TWILIO_AUTH_TOKEN (API Secret): ${apiKeySecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`TWILIO_MAIN_ACCOUNT_SID: ${mainAccountSid ? '✅ Set' : '❌ Missing'}`);
  console.log(`TWILIO_FROM_NUMBER: ${fromNumber || '❌ Missing'}`);
  
  // Check if this is an API Key (starts with SK) or Account SID (starts with AC)
  const isApiKey = apiKeySid && apiKeySid.startsWith('SK');
  console.log(`Credential Type: ${isApiKey ? '🔑 API Key' : '🏢 Account SID'}`);
  console.log('');
  
  if (!apiKeySid || !apiKeySecret || !fromNumber) {
    console.log('❌ Missing Twilio credentials in .env file');
    return;
  }
  
  if (isApiKey && !mainAccountSid) {
    console.log('❌ API Key detected but missing TWILIO_MAIN_ACCOUNT_SID');
    console.log('Add this to your .env file:');
    console.log('TWILIO_MAIN_ACCOUNT_SID=AC...');
    return;
  }
  
  try {
    let client;
    
    if (isApiKey && mainAccountSid) {
      // API Key authentication with main Account SID
      console.log('🔑 Using API Key authentication');
      console.log(`API Key SID: ${apiKeySid}`);
      console.log(`Main Account SID: ${mainAccountSid}`);
      client = twilio(apiKeySid, apiKeySecret, { accountSid: mainAccountSid });
    } else {
      // Standard Account SID authentication
      console.log('🏢 Using Account SID authentication');
      client = twilio(apiKeySid, apiKeySecret);
    }
    
    // Test phone number parsing
    const testNumber = '+61427906691';
    console.log('📱 Testing phone number parsing:');
    const parseResult = parsePhoneNumberSmart(testNumber, 'AU');
    console.log(`Input: ${testNumber}`);
    console.log(`Valid: ${parseResult.isValid ? '✅' : '❌'}`);
    console.log(`Formatted: ${parseResult.formattedNational || 'Invalid'}`);
    console.log(`International: ${parseResult.internationalNumber || 'N/A'}`);
    console.log('');
    
    if (!parseResult.isValid) {
      console.log('❌ Phone number validation failed');
      return;
    }
    
    // Send test SMS
    console.log('📤 Sending test SMS...');
    const message = await client.messages.create({
      body: 'Test message from Let My People Grow! 🇦🇺 Your login code is: 123456. This code expires in 10 minutes.',
      from: fromNumber,
      to: parseResult.internationalNumber
    });
    
    console.log('✅ SMS sent successfully!');
    console.log(`Message SID: ${message.sid}`);
    console.log(`Status: ${message.status}`);
    console.log(`From: ${fromNumber}`);
    console.log(`To: ${parseResult.internationalNumber}`);
    console.log(`Formatted: ${parseResult.formattedNational}`);
    console.log('');
    console.log('📱 Check your phone for the test message!');
    
  } catch (error) {
    console.log('❌ SMS test failed:');
    console.log(`Error: ${error.message}`);
    
    // Provide helpful error guidance
    if (error.code === 20003) {
      console.log('💡 This error usually means authentication failed - check your credentials');
    } else if (error.code === 21211) {
      console.log('💡 Invalid "To" phone number - check the number format');
    } else if (error.code === 21212) {
      console.log('💡 Invalid "From" phone number - check your Twilio number');
    } else if (error.code === 21408) {
      console.log('💡 Permission denied - check if your Twilio account can send to this number');
    } else if (error.code === 21610) {
      console.log('💡 Message cannot be sent to this number - check regional restrictions');
    }
    
    console.log('\n🔍 Troubleshooting:');
    console.log('1. Verify Twilio credentials in .env file');
    console.log('2. Check Twilio account balance');
    console.log('3. Verify phone number permissions');
    console.log('4. Check if numbers are verified in trial account');
  }
}

// Run the test
testSMS().catch(console.error); 