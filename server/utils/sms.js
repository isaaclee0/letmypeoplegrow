const crypto = require('crypto');
const { getInternationalFormat, maskPhoneNumber, validatePhoneNumber } = require('./phoneNumber');
const Database = require('../config/database');
// Node 18+ has global fetch

const CRAZYTEL_API_URL = 'https://sms.crazytel.net.au/api/v1/sms/send';
const getCrazytelConfig = () => ({
  apiKey: process.env.CRAZYTEL_API_KEY,
  fromNumber: process.env.CRAZYTEL_FROM_NUMBER,
});

// Configure Twilio with validation - TEMPORARILY DISABLED
// const accountSid = process.env.TWILIO_ACCOUNT_SID;
// const authToken = process.env.TWILIO_AUTH_TOKEN;
// const fromNumber = process.env.TWILIO_FROM_NUMBER;

// let twilioClient = null;

// Initialize Twilio client if credentials are available and valid - TEMPORARILY DISABLED
// const initializeTwilio = () => {
//   try {
//     if (accountSid && authToken && fromNumber) {
//       // Validate accountSid format
//       if (!accountSid.startsWith('AC')) {
//         console.warn('⚠️ Invalid Twilio Account SID format. SMS functionality will be disabled.');
//         return null;
//       }
//       
//       // Validate authToken format (should be 32 characters)
//       if (authToken.length !== 32) {
//         console.warn('⚠️ Invalid Twilio Auth Token format. SMS functionality will be disabled.');
//         return null;
//       }
//       
//       twilioClient = twilio(accountSid, authToken);
//       console.log('✅ Twilio client initialized successfully');
//       return twilioClient;
//     } else {
//       console.warn('⚠️ Twilio credentials not configured. SMS functionality will be disabled.');
//       return null;
//     }
//   } catch (error) {
//     console.warn('⚠️ Failed to initialize Twilio client:', error.message);
//     return null;
//   }
// };

// Initialize Twilio client - TEMPORARILY DISABLED
// twilioClient = initializeTwilio();

// Get church country context for phone number parsing
const getChurchCountry = async () => {
  try {
    const settings = await Database.query('SELECT country_code FROM church_settings LIMIT 1');
    return settings.length > 0 ? settings[0].country_code : 'AU';
  } catch (error) {
    console.warn('Failed to get church country, defaulting to AU:', error.message);
    return 'AU';
  }
};

// Generate a random 6-digit code
const generateOTC = () => {
  return crypto.randomInt(100000, 999999).toString();
};

// Send One-Time Code via SMS using Crazytel
const sendOTCSMS = async (phoneNumber, code) => {
  const { apiKey, fromNumber } = getCrazytelConfig();
  if (!apiKey || !fromNumber) {
    console.warn('⚠️ Crazytel not configured. Skipping SMS send.');
    return { success: false, error: 'SMS service not configured' };
  }

  try {
    const countryCode = await getChurchCountry();
    const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
    if (!internationalNumber) {
      console.error('❌ Invalid phone number format:', phoneNumber);
      return { success: false, error: 'Invalid phone number format' };
    }

    const messageBody = `Your Let My People Grow login code is: ${code}. Expires in ${process.env.OTC_EXPIRE_MINUTES || 10} minutes.`;

    const response = await fetch(CRAZYTEL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: internationalNumber,
        from: fromNumber,
        message: messageBody,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('❌ Error sending OTC SMS via Crazytel:', data);
      return { success: false, error: data?.message || `HTTP ${response.status}` };
    }

    console.log('✅ OTC SMS sent successfully via Crazytel:', data);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Error sending OTC SMS via Crazytel:', error);
    return { success: false, error: error.message };
  }
};

// Send invitation via SMS using Crazytel
const sendInvitationSMS = async (phoneNumber, firstName, lastName, role, invitationLink, invitedBy) => {
  const { apiKey, fromNumber } = getCrazytelConfig();
  if (!apiKey || !fromNumber) {
    console.warn('⚠️ Crazytel not configured. Skipping SMS invitation send.');
    return { success: false, error: 'SMS service not configured' };
  }

  try {
    const countryCode = await getChurchCountry();
    const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
    if (!internationalNumber) {
      console.error('❌ Invalid phone number format:', phoneNumber);
      return { success: false, error: 'Invalid phone number format' };
    }

    const roleDisplayName = role === 'attendance_taker' ? 'Attendance Taker' : role === 'coordinator' ? 'Coordinator' : role;
    const inviterName = `${invitedBy.first_name || invitedBy.firstName || ''} ${invitedBy.last_name || invitedBy.lastName || ''}`.trim();
    const messageBody = `Hi ${firstName}! ${inviterName} invited you to Let My People Grow as a ${roleDisplayName}. Accept: ${invitationLink} (7 days)`;

    const response = await fetch(CRAZYTEL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: internationalNumber,
        from: fromNumber,
        message: messageBody,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('❌ Error sending invitation SMS via Crazytel:', data);
      return { success: false, error: data?.message || `HTTP ${response.status}` };
    }

    console.log('✅ Invitation SMS sent successfully via Crazytel:', data);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Error sending invitation SMS via Crazytel:', error);
    return { success: false, error: error.message };
  }
};

// Send notification via SMS using Crazytel
const sendNotificationSMS = async (phoneNumber, subject, message) => {
  const { apiKey, fromNumber } = getCrazytelConfig();
  if (!apiKey || !fromNumber) {
    console.warn('⚠️ Crazytel not configured. Skipping SMS notification send.');
    return { success: false, error: 'SMS service not configured' };
  }

  try {
    const countryCode = await getChurchCountry();
    const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
    if (!internationalNumber) {
      console.error('❌ Invalid phone number format:', phoneNumber);
      return { success: false, error: 'Invalid phone number format' };
    }

    const messageBody = `Let My People Grow - ${subject}: ${message}`;

    const response = await fetch(CRAZYTEL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: internationalNumber,
        from: fromNumber,
        message: messageBody,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('❌ Error sending notification SMS via Crazytel:', data);
      return { success: false, error: data?.message || `HTTP ${response.status}` };
    }

    console.log('✅ Notification SMS sent successfully via Crazytel:', data);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Error sending notification SMS via Crazytel:', error);
    return { success: false, error: error.message };
  }
};

// Test SMS configuration for Crazytel
const testSMSConfig = async () => {
  const { apiKey, fromNumber } = getCrazytelConfig();
  if (!apiKey || !fromNumber) return false;
  return true;
};

// Format phone number for display (country-aware)
const formatPhoneNumber = async (phoneNumber) => {
  if (!phoneNumber) return '';
  
  try {
    const countryCode = await getChurchCountry();
    const { formatPhoneNumberDisplay } = require('./phoneNumber');
    return formatPhoneNumberDisplay(phoneNumber, countryCode);
  } catch (error) {
    // Fallback to simple formatting
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    }
    return phoneNumber;
  }
};

// Validate phone number format (country-aware)
const isValidPhoneNumber = async (phoneNumber) => {
  if (!phoneNumber) return false;
  
  try {
    const countryCode = await getChurchCountry();
    return validatePhoneNumber(phoneNumber, countryCode);
  } catch (error) {
    // Fallback validation
    const cleaned = phoneNumber.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
  }
};

module.exports = {
  generateOTC,
  sendOTCSMS,
  sendInvitationSMS,
  sendNotificationSMS,
  testSMSConfig,
  formatPhoneNumber,
  isValidPhoneNumber,
  getChurchCountry,
  
  // Re-export phone number utilities for convenience
  ...require('./phoneNumber')
}; 