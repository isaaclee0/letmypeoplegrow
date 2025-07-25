const { parsePhoneNumber, isValidPhoneNumber, getCountryCallingCode } = require('libphonenumber-js');

// Common country configurations with their expected local formats
const COUNTRY_CONFIGS = {
  'US': {
    name: 'United States',
    formats: ['(555) 123-4567', '555-123-4567', '5551234567'],
    description: 'Enter as: (555) 123-4567 or 555-123-4567'
  },
  'AU': {
    name: 'Australia', 
    formats: ['0400 000 000', '04 0000 0000', '0400000000'],
    description: 'Enter as: 0400 000 000 or 04 0000 0000'
  },
  'GB': {
    name: 'United Kingdom',
    formats: ['07700 900123', '077 0090 0123', '07700900123'],
    description: 'Enter as: 07700 900123 or 077 0090 0123'
  },
  'CA': {
    name: 'Canada',
    formats: ['(555) 123-4567', '555-123-4567', '5551234567'],
    description: 'Enter as: (555) 123-4567 or 555-123-4567'
  },
  'NZ': {
    name: 'New Zealand',
    formats: ['021 123 4567', '02112345678'],
    description: 'Enter as: 021 123 4567 or 021-123-4567'
  },
  'ZA': {
    name: 'South Africa',
    formats: ['082 123 4567', '0821234567'],
    description: 'Enter as: 082 123 4567 or 082-123-4567'
  },
  'IN': {
    name: 'India',
    formats: ['98765 43210', '+91 98765 43210'],
    description: 'Enter as: 98765 43210 or +91 98765 43210'
  },
  'SG': {
    name: 'Singapore',
    formats: ['9123 4567', '+65 9123 4567'],
    description: 'Enter as: 9123 4567 or +65 9123 4567'
  },
  'DE': {
    name: 'Germany',
    formats: ['0170 1234567', '+49 170 1234567'],
    description: 'Enter as: 0170 1234567 or +49 170 1234567'
  },
  'FR': {
    name: 'France',
    formats: ['06 12 34 56 78', '+33 6 12 34 56 78'],
    description: 'Enter as: 06 12 34 56 78 or +33 6 12 34 56 78'
  }
};

// Get country configuration
const getCountryConfig = (countryCode) => {
  return COUNTRY_CONFIGS[countryCode?.toUpperCase()] || COUNTRY_CONFIGS['AU'];
};

// Get all supported countries
const getSupportedCountries = () => {
  return Object.entries(COUNTRY_CONFIGS).map(([code, config]) => ({
    code,
    name: config.name,
    callingCode: `+${getCountryCallingCode(code)}`,
    description: config.description,
    formats: config.formats
  }));
};

// Parse and format phone number intelligently
const parsePhoneNumberSmart = (phoneInput, countryCode = 'AU') => {
  if (!phoneInput || typeof phoneInput !== 'string') {
    return {
      isValid: false,
      error: 'Phone number is required'
    };
  }

  try {
    // Clean the input - remove extra spaces and common separators
    let cleanInput = phoneInput.trim();
    
    // If the number already has a country code (starts with +), parse it directly
    if (cleanInput.startsWith('+')) {
      const phoneNumber = parsePhoneNumber(cleanInput);
      if (phoneNumber && phoneNumber.isValid()) {
        return {
          isValid: true,
          nationalNumber: phoneNumber.nationalNumber,
          internationalNumber: phoneNumber.number,
          formattedNational: phoneNumber.formatNational(),
          formattedInternational: phoneNumber.formatInternational(),
          country: phoneNumber.country,
          countryCallingCode: phoneNumber.countryCallingCode
        };
      }
    }

    // Parse with country context
    const phoneNumber = parsePhoneNumber(cleanInput, countryCode.toUpperCase());
    if (phoneNumber && phoneNumber.isValid()) {
      return {
        isValid: true,
        nationalNumber: phoneNumber.nationalNumber,
        internationalNumber: phoneNumber.number,
        formattedNational: phoneNumber.formatNational(),
        formattedInternational: phoneNumber.formatInternational(),
        country: phoneNumber.country,
        countryCallingCode: phoneNumber.countryCallingCode
      };
    }

    // If parsing with country context fails, try to be more flexible
    // For numbers that might be missing a leading digit or have extra formatting
    const flexibleAttempts = [
      cleanInput,
      cleanInput.replace(/\D/g, ''), // Remove all non-digits
      '0' + cleanInput.replace(/\D/g, ''), // Add leading zero (common in many countries)
      cleanInput.replace(/^0/, ''), // Remove leading zero
    ];

    for (const attempt of flexibleAttempts) {
      try {
        const phoneNumber = parsePhoneNumber(attempt, countryCode.toUpperCase());
        if (phoneNumber && phoneNumber.isValid()) {
          return {
            isValid: true,
            nationalNumber: phoneNumber.nationalNumber,
            internationalNumber: phoneNumber.number,
            formattedNational: phoneNumber.formatNational(),
            formattedInternational: phoneNumber.formatInternational(),
            country: phoneNumber.country,
            countryCallingCode: phoneNumber.countryCallingCode
          };
        }
      } catch (e) {
        // Continue to next attempt
      }
    }

    return {
      isValid: false,
      error: `Invalid phone number format for ${getCountryConfig(countryCode).name}. ${getCountryConfig(countryCode).description}`
    };

  } catch (error) {
    return {
      isValid: false,
      error: `Invalid phone number: ${error.message}`
    };
  }
};

// Validate phone number for a specific country
const validatePhoneNumber = (phoneInput, countryCode = 'AU') => {
  const result = parsePhoneNumberSmart(phoneInput, countryCode);
  return result.isValid;
};

// Format phone number for display (national format)
const formatPhoneNumberDisplay = (phoneInput, countryCode = 'AU') => {
  const result = parsePhoneNumberSmart(phoneInput, countryCode);
  if (result.isValid) {
    return result.formattedNational;
  }
  return phoneInput; // Return original if can't format
};

// Get international format for Twilio
const getInternationalFormat = (phoneInput, countryCode = 'AU') => {
  const result = parsePhoneNumberSmart(phoneInput, countryCode);
  if (result.isValid) {
    return result.internationalNumber;
  }
  return null;
};

// Mask phone number for display (keeping last 4 digits)
const maskPhoneNumber = (phoneInput, countryCode = 'AU') => {
  const result = parsePhoneNumberSmart(phoneInput, countryCode);
  if (result.isValid && result.formattedNational) {
    // Replace digits with * except last 4
    const formatted = result.formattedNational;
    const digits = formatted.replace(/\D/g, '');
    if (digits.length > 4) {
      const lastFour = digits.slice(-4);
      const maskedDigits = '*'.repeat(digits.length - 4) + lastFour;
      return formatted.replace(/\d/g, (match, index) => {
        const digitIndex = formatted.substring(0, index).replace(/\D/g, '').length;
        return maskedDigits[digitIndex] || match;
      });
    }
  }
  return phoneInput;
};

// Get example phone number for a country
const getExamplePhoneNumber = (countryCode = 'AU') => {
  const config = getCountryConfig(countryCode);
  return config.formats[0] || '';
};

// Check if a country supports mobile numbers
const supportsMobileNumbers = (countryCode) => {
  try {
    const callingCode = getCountryCallingCode(countryCode.toUpperCase());
    return !!callingCode;
  } catch (e) {
    return false;
  }
};

module.exports = {
  parsePhoneNumberSmart,
  validatePhoneNumber,
  formatPhoneNumberDisplay,
  getInternationalFormat,
  maskPhoneNumber,
  getExamplePhoneNumber,
  getCountryConfig,
  getSupportedCountries,
  supportsMobileNumbers,
  
  // Legacy compatibility
  isValidPhoneNumber: validatePhoneNumber,
  formatPhoneNumber: formatPhoneNumberDisplay
}; 