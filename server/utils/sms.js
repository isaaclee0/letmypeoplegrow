// Twilio SMS functionality temporarily disabled
// const twilio = require('twilio');
const crypto = require('crypto');
const { getInternationalFormat, maskPhoneNumber, validatePhoneNumber } = require('./phoneNumber');
const Database = require('../config/database');

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

// Send One-Time Code via SMS - TEMPORARILY DISABLED
const sendOTCSMS = async (phoneNumber, code) => {
  console.log('📱 SMS functionality temporarily disabled. Code would be:', code);
  return { success: false, error: 'SMS service temporarily disabled' };
  
  // if (!twilioClient || !fromNumber) {
  //   console.error('❌ Twilio not configured. Cannot send SMS.');
  //   return { success: false, error: 'SMS service not configured' };
  // }

  // try {
  //   // Get church country for intelligent parsing
  //   const countryCode = await getChurchCountry();
  //   
  //   // Parse phone number intelligently based on country
  //   const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
  //   if (!internationalNumber) {
  //     console.error('❌ Invalid phone number format:', phoneNumber);
  //     return { success: false, error: 'Invalid phone number format' };
  //   }

  //   const message = await twilioClient.messages.create({
  //     body: `Your Let My People Grow login code is: ${code}. This code expires in ${process.env.OTC_EXPIRE_MINUTES || 10} minutes.`,
  //     from: fromNumber,
  //     to: internationalNumber
  //   });

  //   console.log('✅ OTC SMS sent successfully via Twilio:', message.sid);
  //   return { success: true, messageId: message.sid };
  //   
  // } catch (error) {
  //   console.error('❌ Error sending OTC SMS via Twilio:', error);
  //   return { success: false, error: error.message };
  // }
};

// Send invitation via SMS - TEMPORARILY DISABLED
const sendInvitationSMS = async (phoneNumber, firstName, lastName, role, invitationLink, invitedBy) => {
  console.log('📱 SMS invitation functionality temporarily disabled');
  return { success: false, error: 'SMS service temporarily disabled' };
  
  // console.log('📱 [SMS_DEBUG] Starting invitation SMS send', {
  //   phoneNumber,
  //   firstName,
  //   lastName,
  //   role,
  //   invitationLink,
  //   invitedBy: {
  //     firstName: invitedBy.firstName,
  //     lastName: invitedBy.lastName
  //   }
  // });

  // if (!twilioClient || !fromNumber) {
  //   console.error('❌ [SMS_DEBUG] Twilio not configured. Cannot send SMS.');
  //   return { success: false, error: 'SMS service not configured' };
  // }

  // try {
  //   // Get church country for intelligent parsing
  //   const countryCode = await getChurchCountry();
  //   console.log('🌍 [SMS_DEBUG] Church country code:', countryCode);
  //   
  //   // Parse phone number intelligently based on country
  //   const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
  //   console.log('📱 [SMS_DEBUG] International number:', internationalNumber);
  //   
  //   if (!internationalNumber) {
  //     console.error('❌ [SMS_DEBUG] Invalid phone number format:', phoneNumber);
  //     return { success: false, error: 'Invalid phone number format' };
  //   }

  //   const roleDisplayName = role === 'attendance_taker' ? 'Attendance Taker' : 
  //                          role === 'coordinator' ? 'Coordinator' : role;

  //   const messageBody = `Hi ${firstName}! ${invitedBy.firstName} ${invitedBy.lastName} has invited you to join Let My People Grow as a ${roleDisplayName}. Accept your invitation: ${invitationLink} (Expires in 7 days)`;
  //   
  //   console.log('📱 [SMS_DEBUG] SMS message prepared', {
  //     body: messageBody,
  //     from: fromNumber,
  //     to: internationalNumber
  //   });

  //   const message = await twilioClient.messages.create({
  //     body: messageBody,
  //     from: fromNumber,
  //     to: internationalNumber
  //   });

  //   console.log('✅ [SMS_DEBUG] Invitation SMS sent successfully via Twilio:', message.sid);
  //   return { success: true, messageId: message.sid };
  //   
  // } catch (error) {
  //   console.error('❌ [SMS_DEBUG] Error sending invitation SMS via Twilio:', error);
  //   console.error('❌ [SMS_DEBUG] Error details:', {
  //     message: error.message,
  //     code: error.code,
  //     status: error.status
  //   });
  //   return { success: false, error: error.message };
  // }
};

// Send notification via SMS - TEMPORARILY DISABLED
const sendNotificationSMS = async (phoneNumber, subject, message) => {
  console.log('📱 SMS notification functionality temporarily disabled');
  return { success: false, error: 'SMS service temporarily disabled' };
  
  // if (!twilioClient || !fromNumber) {
  //   console.error('❌ Twilio not configured. Cannot send SMS.');
  //   return { success: false, error: 'SMS service not configured' };
  // }

  // try {
  //   // Get church country for intelligent parsing
  //   const countryCode = await getChurchCountry();
  //   
  //   // Parse phone number intelligently based on country
  //   const internationalNumber = getInternationalFormat(phoneNumber, countryCode);
  //   if (!internationalNumber) {
  //     console.error('❌ Invalid phone number format:', phoneNumber);
  //     return { success: false, error: 'Invalid phone number format' };
  //   }

  //   const smsMessage = await twilioClient.messages.create({
  //     body: `Let My People Grow - ${subject}: ${message}`,
  //     from: fromNumber,
  //     to: internationalNumber
  //   });

  //   console.log('✅ Notification SMS sent successfully via Twilio:', smsMessage.sid);
  //   return { success: true, messageId: smsMessage.sid };
  //   
  // } catch (error) {
  //   console.error('❌ Error sending notification SMS via Twilio:', error);
  //   return { success: false, error: error.message };
  // }
};

// Test SMS configuration - TEMPORARILY DISABLED
const testSMSConfig = async () => {
  console.log('📱 SMS configuration testing temporarily disabled');
  return false;
  
  // if (!twilioClient || !fromNumber) {
  //   console.error('❌ Twilio configuration incomplete');
  //   return false;
  // }

  // try {
  //   // Test by validating the phone number format
  //   await twilioClient.lookups.v1.phoneNumbers(fromNumber).fetch();
  //   console.log('✅ Twilio SMS configuration is valid');
  //   return true;
  // } catch (error) {
  //   console.error('❌ Twilio SMS configuration error:', error.message);
  //   return false;
  // }
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