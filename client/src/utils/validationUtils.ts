/**
 * Shared validation utilities for forms and data input
 * Now using Yup schemas for robust validation
 */
import * as yup from 'yup';
import {
  personSchema,
  familyNameSchema,
  multiplePeopleSchema,
  csvDataSchema,
  visitorFormSchema
} from './schemas';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface PersonValidation {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  lastNameUnknown?: boolean;
  firstNameUnknown?: boolean;
}

/**
 * Validates a person's basic information using Yup schema
 */
export const validatePerson = (person: PersonValidation): ValidationResult => {
  try {
    personSchema.validateSync(person, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Validates a family name using Yup schema
 */
export const validateFamilyName = (familyName: string): ValidationResult => {
  try {
    familyNameSchema.validateSync({ familyName }, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Validates multiple people at once using Yup schema
 * Returns aggregated validation results
 */
export const validateMultiplePeople = (people: PersonValidation[]): ValidationResult => {
  try {
    multiplePeopleSchema.validateSync({ people }, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Sanitizes text input to prevent XSS and clean up formatting
 */
export const sanitizeText = (input: string): string => {
  if (!input) return '';
  
  return input
    .trim()
    // Remove potentially dangerous HTML/script tags
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Validates CSV data format using Yup schema
 */
export const validateCSVData = (csvData: string): ValidationResult => {
  try {
    csvDataSchema.validateSync({ csvData }, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Validates visitor form data using Yup schema
 */
export const validateVisitorForm = (data: any): ValidationResult => {
  try {
    visitorFormSchema.validateSync(data, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Async validation function for better performance with complex validation
 */
export const validatePersonAsync = async (person: PersonValidation): Promise<ValidationResult> => {
  try {
    await personSchema.validate(person, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};

/**
 * Validates and transforms data, returning both validation result and cleaned data
 */
export const validateAndTransform = <T>(
  schema: yup.Schema<T>,
  data: any
): { validation: ValidationResult; data?: T } => {
  try {
    const validatedData = schema.validateSync(data, { abortEarly: false });
    return {
      validation: { isValid: true, errors: [] },
      data: validatedData
    };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        validation: {
          isValid: false,
          errors: error.errors
        }
      };
    }
    return {
      validation: {
        isValid: false,
        errors: ['Unknown validation error']
      }
    };
  }
};

/**
 * Debounced validation function
 * Useful for real-time form validation without excessive API calls
 */
export const createDebouncedValidator = <T>(
  validator: (data: T) => ValidationResult,
  delay: number = 300
) => {
  let timeoutId: NodeJS.Timeout;
  
  return (data: T, callback: (result: ValidationResult) => void) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      const result = validator(data);
      callback(result);
    }, delay);
  };
};

/**
 * Field-level validation for real-time feedback
 */
export const validateField = (
  fieldName: string,
  value: any,
  schema: yup.Schema<any>
): ValidationResult => {
  try {
    schema.validateSyncAt(fieldName, { [fieldName]: value }, { abortEarly: false });
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return {
        isValid: false,
        errors: error.errors
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error']
    };
  }
};
