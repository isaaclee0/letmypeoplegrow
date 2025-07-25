import React, { useState, useEffect } from 'react';
import { parsePhoneNumber, AsYouType, getExampleNumber } from 'libphonenumber-js';

interface PhoneNumberInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  countryCode?: string;
  placeholder?: string;
  className?: string;
  error?: string;
  required?: boolean;
  id?: string;
  name?: string;
}

const PhoneNumberInput: React.FC<PhoneNumberInputProps> = ({
  value,
  onChange,
  onBlur,
  countryCode = 'AU',
  placeholder,
  className = '',
  error,
  required = false,
  id,
  name
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [isValid, setIsValid] = useState(true);

  // Update display value when value prop changes
  useEffect(() => {
    setDisplayValue(value);
    validateNumber(value);
  }, [value, countryCode]);

  // Get placeholder based on country
  const getPlaceholder = () => {
    if (placeholder) return placeholder;
    
    try {
      const example = getExampleNumber(countryCode as any, undefined as any);
      if (example) {
        return example.formatNational();
      }
    } catch (e) {
      // Fallback placeholders for common countries
      const placeholders: { [key: string]: string } = {
        'AU': '0400 000 000',
        'US': '(555) 123-4567',
        'GB': '07700 900123',
        'CA': '(555) 123-4567',
        'NZ': '021 123 4567',
        'ZA': '082 123 4567',
        'IN': '98765 43210',
        'SG': '9123 4567',
        'DE': '0170 1234567',
        'FR': '06 12 34 56 78'
      };
      return placeholders[countryCode] || '0400 000 000';
    }
    return 'Enter phone number';
  };

  // Validate phone number
  const validateNumber = (phoneNumber: string) => {
    if (!phoneNumber.trim()) {
      setIsValid(true); // Empty is valid if not required
      return;
    }

    try {
      const parsed = parsePhoneNumber(phoneNumber, countryCode as any);
      setIsValid(parsed?.isValid() || false);
    } catch (e) {
      setIsValid(false);
    }
  };

  // Handle input change with formatting
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    
    // Use AsYouType formatter for real-time formatting
    const formatter = new AsYouType(countryCode as any);
    let formatted = '';
    
    try {
      // Clear the formatter and add each character
      for (const char of inputValue) {
        formatted = formatter.input(char);
      }
      
      // If the user is deleting, don't reformat
      if (inputValue.length < displayValue.length) {
        formatted = inputValue;
      }
    } catch (e) {
      formatted = inputValue;
    }

    setDisplayValue(formatted);
    validateNumber(inputValue);
    
    // Always call onChange with the cleaned value for storage
    const cleanValue = inputValue.replace(/\D/g, '');
    onChange(formatted); // Pass formatted value to parent
  };

  // Handle blur event
  const handleBlur = () => {
    validateNumber(displayValue);
    if (onBlur) onBlur();
  };

  // Get the appropriate CSS classes
  const inputClasses = `
    ${className}
    ${error || (!isValid && displayValue.trim()) 
      ? 'border-red-300 focus:border-red-500 focus:ring-red-500' 
      : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
    }
  `.trim();

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type="tel"
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={getPlaceholder()}
        className={inputClasses}
        required={required}
        autoComplete="tel"
      />
      
      {/* Country indicator */}
      <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
        <span className="text-xs text-gray-400 font-mono">
          {countryCode.toUpperCase()}
        </span>
      </div>
      
      {/* Validation message */}
      {displayValue.trim() && !isValid && (
        <p className="mt-1 text-xs text-red-600">
          Please enter a valid phone number for {countryCode.toUpperCase()}
        </p>
      )}
      
      {/* Error message from parent */}
      {error && (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
};

export default PhoneNumberInput; 