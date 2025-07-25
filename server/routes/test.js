const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');
const { sendOTCSMS, testSMSConfig, getInternationalFormat } = require('../utils/sms');
const { parsePhoneNumberSmart } = require('../utils/phoneNumber');

const router = express.Router();

// Test SMS configuration and send test message
router.post('/sms', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    // Default to your test number if none provided
    const testNumber = phoneNumber || '+61427906691';
    
    console.log('🧪 Testing SMS with Twilio...');
    console.log('📱 Test number:', testNumber);
    console.log('📤 From number:', process.env.TWILIO_FROM_NUMBER);
    
    // Test SMS configuration first
    const configTest = await testSMSConfig();
    if (!configTest) {
      return res.status(500).json({ 
        error: 'SMS configuration test failed. Check your Twilio credentials.' 
      });
    }
    
    // Parse the phone number to show formatting details
    const parseResult = parsePhoneNumberSmart(testNumber, 'AU');
    console.log('📋 Phone number parsing result:', parseResult);
    
    // Send test SMS
    const testCode = '123456';
    const result = await sendOTCSMS(testNumber, testCode);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Test SMS sent successfully!',
        messageId: result.messageId,
        testNumber: testNumber,
        fromNumber: process.env.TWILIO_FROM_NUMBER,
        parseResult: parseResult,
        note: 'Check the target phone for the test message with code: 123456'
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        testNumber: testNumber,
        fromNumber: process.env.TWILIO_FROM_NUMBER,
        parseResult: parseResult
      });
    }
    
  } catch (error) {
    console.error('SMS test error:', error);
    res.status(500).json({ 
      error: 'SMS test failed',
      details: error.message 
    });
  }
});

// Test phone number parsing for various Australian formats
router.post('/parse-phone', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    console.log('🧪 Testing phone number parsing for:', phoneNumber);
    
    // Test parsing with AU context
    const parseResult = parsePhoneNumberSmart(phoneNumber, 'AU');
    
    // Test getting international format
    const international = getInternationalFormat(phoneNumber, 'AU');
    
    res.json({
      success: true,
      input: phoneNumber,
      countryContext: 'AU',
      parseResult: parseResult,
      internationalFormat: international,
      isValid: parseResult.isValid,
      formatted: parseResult.isValid ? parseResult.formattedNational : null
    });
    
  } catch (error) {
    console.error('Phone parsing test error:', error);
    res.status(500).json({ 
      error: 'Phone parsing test failed',
      details: error.message 
    });
  }
});

// Test various Australian phone number formats
router.get('/test-au-formats', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const testNumbers = [
      '0400 000 000',
      '04 0000 0000', 
      '0400000000',
      '400 000 000',
      '400000000',
      '+61 400 000 000',
      '+61400000000',
      '0427906691',
      '0427 906 691',
      '04 2790 6691',
      '+61427906691',
      '+61 427 906 691'
    ];
    
    const results = [];
    
    for (const testNumber of testNumbers) {
      try {
        const parseResult = parsePhoneNumberSmart(testNumber, 'AU');
        const international = getInternationalFormat(testNumber, 'AU');
        
        results.push({
          input: testNumber,
          isValid: parseResult.isValid,
          formatted: parseResult.isValid ? parseResult.formattedNational : null,
          international: international,
          error: parseResult.error || null
        });
      } catch (error) {
        results.push({
          input: testNumber,
          isValid: false,
          formatted: null,
          international: null,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      message: 'Australian phone number format testing completed',
      countryContext: 'AU',
      results: results
    });
    
  } catch (error) {
    console.error('AU format test error:', error);
    res.status(500).json({ 
      error: 'AU format test failed',
      details: error.message 
    });
  }
});

module.exports = router; 