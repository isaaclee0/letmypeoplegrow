/**
 * Validation schemas using Yup for consistent form validation
 */
import * as yup from 'yup';

// Custom validation for names (allows letters, spaces, hyphens, apostrophes, periods)
const nameRegex = /^[a-zA-Z\s\-'\.]+$/;

// Person validation schema
export const personSchema = yup.object({
  firstName: yup
    .string()
    .required('First name is required')
    .min(1, 'First name must be at least 1 character')
    .max(50, 'First name must be less than 50 characters')
    .matches(nameRegex, 'First name contains invalid characters'),
  
  lastName: yup
    .string()
    .required('Last name is required')
    .min(1, 'Last name must be at least 1 character')
    .max(50, 'Last name must be less than 50 characters')
    .matches(nameRegex, 'Last name contains invalid characters'),
  
  email: yup
    .string()
    .email('Email format is invalid')
    .max(255, 'Email must be less than 255 characters')
    .optional(),
  
  phone: yup
    .string()
    .test('phone-length', 'Phone number must be between 7 and 15 digits', function(value) {
      if (!value) return true; // Optional field
      const digitsOnly = value.replace(/\D/g, '');
      return digitsOnly.length >= 7 && digitsOnly.length <= 15;
    })
    .optional(),
    
  lastNameUnknown: yup.boolean().optional(),
  firstNameUnknown: yup.boolean().optional()
});

// Family name validation schema
export const familyNameSchema = yup.object({
  familyName: yup
    .string()
    .required('Family name is required')
    .min(3, 'Family name must be at least 3 characters')
    .max(100, 'Family name must be less than 100 characters')
});

// Multiple people validation schema
export const multiplePeopleSchema = yup.object({
  people: yup
    .array()
    .of(personSchema)
    .min(1, 'At least one person is required')
    .test('no-duplicates', 'Duplicate names found', function(people) {
      if (!people || people.length <= 1) return true;
      
      const nameMap = new Map<string, number[]>();
      people.forEach((person, index) => {
        if (person.firstName?.trim() && person.lastName?.trim()) {
          const fullName = `${person.firstName.trim().toLowerCase()} ${person.lastName.trim().toLowerCase()}`;
          if (!nameMap.has(fullName)) {
            nameMap.set(fullName, []);
          }
          nameMap.get(fullName)!.push(index + 1);
        }
      });
      
      const duplicates = Array.from(nameMap.entries()).filter(([name, indices]) => indices.length > 1);
      if (duplicates.length > 0) {
        const duplicateDetails = duplicates.map(([name, indices]) => 
          `"${name}" at positions: ${indices.join(', ')}`
        ).join('; ');
        return this.createError({
          message: `Duplicate names found: ${duplicateDetails}`,
          path: 'people'
        });
      }
      
      return true;
    })
});

// CSV data validation schema
export const csvDataSchema = yup.object({
  csvData: yup
    .string()
    .required('CSV data is required')
    .test('valid-csv', 'Invalid CSV format', function(value) {
      if (!value?.trim()) {
        return this.createError({ message: 'CSV data is required' });
      }
      
      const lines = value.trim().split('\n').filter(line => line.trim());
      
      if (lines.length === 0) {
        return this.createError({ message: 'CSV data contains no valid rows' });
      }
      
      // Check if first line looks like a header
      const firstLine = lines[0].toLowerCase();
      const hasHeaders = firstLine.includes('first') && firstLine.includes('last');
      const dataStartIndex = hasHeaders ? 1 : 0;
      
      if (lines.length <= dataStartIndex) {
        return this.createError({ message: 'CSV data contains no data rows' });
      }
      
      // Validate each data row
      const errors: string[] = [];
      lines.slice(dataStartIndex).forEach((line, index) => {
        const rowNumber = index + dataStartIndex + 1;
        const columns = line.split(/[,\t]/).map(col => col.trim().replace(/"/g, ''));
        
        if (columns.length < 2) {
          errors.push(`Row ${rowNumber}: Must have at least first name and last name`);
        } else {
          if (!columns[0]) {
            errors.push(`Row ${rowNumber}: First name is required`);
          }
          if (!columns[1]) {
            errors.push(`Row ${rowNumber}: Last name is required`);
          }
        }
      });
      
      if (errors.length > 0) {
        return this.createError({ message: errors.join('; ') });
      }
      
      return true;
    })
});

// Visitor form schema (for AttendancePage)
export const visitorFormSchema = yup.object({
  personType: yup
    .string()
    .oneOf(['regular', 'local_visitor', 'traveller_visitor'], 'Invalid person type')
    .required('Person type is required'),
  
  notes: yup
    .string()
    .max(500, 'Notes must be less than 500 characters')
    .optional(),
  
  persons: yup
    .array()
    .of(yup.object({
      firstName: yup.string().required('First name is required'),
      lastName: yup.string().required('Last name is required'),
      lastNameUnknown: yup.boolean().optional(),
      fillLastNameFromAbove: yup.boolean().optional()
    }))
    .min(1, 'At least one person is required'),
  
  autoFillSurname: yup.boolean().optional()
});

// Mass edit schema
export const massEditSchema = yup.object({
  familyInput: yup.string().optional(),
  lastName: yup
    .string()
    .when('lastName', {
      is: (val: string) => val && val.trim(),
      then: (schema) => schema.matches(nameRegex, 'Last name contains invalid characters'),
      otherwise: (schema) => schema
    })
    .optional(),
  peopleType: yup
    .string()
    .oneOf(['', 'regular', 'local_visitor', 'traveller_visitor'], 'Invalid people type')
    .optional()
});

// Family editor schema
export const familyEditorSchema = yup.object({
  familyId: yup.number().required('Family ID is required'),
  familyName: yup
    .string()
    .required('Family name is required')
    .min(3, 'Family name must be at least 3 characters')
    .max(100, 'Family name must be less than 100 characters'),
  familyType: yup
    .string()
    .oneOf(['regular', 'local_visitor', 'traveller_visitor'], 'Invalid family type')
    .required('Family type is required'),
  memberIds: yup.array().of(yup.number()).optional()
});

// Person editor schema
export const personEditorSchema = yup.object({
  id: yup.number().required('Person ID is required'),
  firstName: yup
    .string()
    .required('First name is required')
    .min(1, 'First name must be at least 1 character')
    .max(50, 'First name must be less than 50 characters')
    .matches(nameRegex, 'First name contains invalid characters'),
  lastName: yup
    .string()
    .required('Last name is required')
    .min(1, 'Last name must be at least 1 character')
    .max(50, 'Last name must be less than 50 characters')
    .matches(nameRegex, 'Last name contains invalid characters'),
  peopleType: yup
    .string()
    .oneOf(['regular', 'local_visitor', 'traveller_visitor'], 'Invalid people type')
    .required('People type is required'),
  familyInput: yup.string().optional(),
  newFamilyName: yup.string().optional()
});

export type PersonFormData = yup.InferType<typeof personSchema>;
export type FamilyNameData = yup.InferType<typeof familyNameSchema>;
export type MultiplePeopleData = yup.InferType<typeof multiplePeopleSchema>;
export type CSVData = yup.InferType<typeof csvDataSchema>;
export type VisitorFormData = yup.InferType<typeof visitorFormSchema>;
export type MassEditData = yup.InferType<typeof massEditSchema>;
export type FamilyEditorData = yup.InferType<typeof familyEditorSchema>;
export type PersonEditorData = yup.InferType<typeof personEditorSchema>;
