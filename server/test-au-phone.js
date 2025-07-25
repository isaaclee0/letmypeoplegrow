#!/usr/bin/env node

// Quick test script to demonstrate Australian phone number parsing
const { parsePhoneNumberSmart, getInternationalFormat } = require('./utils/phoneNumber');

console.log('🇦🇺 Testing Australian Phone Number Parsing\n');

const testNumbers = [
  '0427906691',        // Your test number
  '0427 906 691',      // With spaces
  '04 2790 6691',      // Alternative spacing
  '427906691',         // Without leading zero
  '+61427906691',      // International format
  '+61 427 906 691',   // International with spaces
  '0400 000 000',      // Standard format
  '04 0000 0000',      // Alternative
  '0400000000',        // No spaces
  '400000000',         // No leading zero
  '+61 400 000 000',   // International
  'invalid',           // Invalid number
  '12345'              // Too short
];

console.log('Test Number\t\t\tValid?\tFormatted\t\tInternational');
console.log('─'.repeat(80));

testNumbers.forEach(number => {
  try {
    const result = parsePhoneNumberSmart(number, 'AU');
    const international = getInternationalFormat(number, 'AU');
    
    const valid = result.isValid ? '✅' : '❌';
    const formatted = result.isValid ? result.formattedNational : 'Invalid';
    const intl = international || 'N/A';
    
    console.log(`${number.padEnd(20)}\t${valid}\t${formatted.padEnd(15)}\t${intl}`);
    
    if (!result.isValid && result.error) {
      console.log(`  └─ Error: ${result.error}`);
    }
  } catch (error) {
    console.log(`${number.padEnd(20)}\t❌\tError\t\t\t${error.message}`);
  }
});

console.log('\n🧪 Key Features Demonstrated:');
console.log('✅ Accepts various Australian mobile formats');
console.log('✅ Handles spacing and formatting variations');
console.log('✅ Converts to E.164 international format for Twilio');
console.log('✅ Validates numbers according to Australian rules');
console.log('✅ Provides formatted national display format');

console.log('\n📱 Your Twilio Configuration:');
console.log(`From Number: ${process.env.TWILIO_FROM_NUMBER || '+61488839850'}`);
console.log(`Test Target: +61427906691`);
console.log(`Country Context: Australia (AU)`);

console.log('\n🚀 Ready to test SMS! Use the API endpoints in TWILIO_SETUP.md'); 