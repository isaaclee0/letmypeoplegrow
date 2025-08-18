import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { validatePerson, sanitizeText } from '../../utils/validationUtils';

export interface PersonFormData {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  lastNameUnknown?: boolean;
  firstNameUnknown?: boolean;
}

interface PersonFormProps {
  person: PersonFormData;
  index: number;
  showRemove?: boolean;
  autoFillLastName?: boolean;
  lastNameFromAbove?: string;
  onUpdate: (index: number, updates: Partial<PersonFormData>) => void;
  onRemove?: (index: number) => void;
  className?: string;
  showAdvancedFields?: boolean;
}

const PersonForm: React.FC<PersonFormProps> = ({
  person,
  index,
  showRemove = false,
  autoFillLastName = false,
  lastNameFromAbove = '',
  onUpdate,
  onRemove,
  className = '',
  showAdvancedFields = false
}) => {
  const validation = validatePerson(person);
  
  const handleUpdate = (field: keyof PersonFormData, value: string | boolean) => {
    let sanitizedValue = value;
    if (typeof value === 'string') {
      sanitizedValue = sanitizeText(value);
    }
    
    const updates: Partial<PersonFormData> = { [field]: sanitizedValue };
    
    // Auto-fill last name if enabled and this is not the first person
    if (field === 'firstName' && autoFillLastName && lastNameFromAbove && index > 0) {
      updates.lastName = lastNameFromAbove;
    }
    
    onUpdate(index, updates);
  };

  const getFieldError = (field: keyof PersonFormData): string | undefined => {
    if (!validation.isValid) {
      const fieldErrors = validation.errors.filter(error => 
        error.toLowerCase().includes(field.toLowerCase())
      );
      return fieldErrors[0];
    }
    return undefined;
  };

  return (
    <div className={`border border-gray-200 rounded-lg p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h5 className="text-sm font-medium text-gray-700">
          Person {index + 1}
        </h5>
        {showRemove && onRemove && (
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="text-red-600 hover:text-red-800 text-sm"
            title="Remove person"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            First Name *
          </label>
          <div className="mt-1 relative">
            <input
              type="text"
              value={person.firstName}
              onChange={(e) => handleUpdate('firstName', e.target.value)}
              className={`block w-full border rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                getFieldError('firstName') ? 'border-red-300' : 'border-gray-300'
              }`}
              placeholder="First name"
              required
              maxLength={50}
            />
            {person.firstNameUnknown && (
              <div className="flex items-center mt-1">
                <input
                  type="checkbox"
                  checked={person.firstNameUnknown}
                  onChange={(e) => handleUpdate('firstNameUnknown', e.target.checked)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="ml-2 text-sm text-gray-600">Unknown first name</span>
              </div>
            )}
            {getFieldError('firstName') && (
              <p className="mt-1 text-sm text-red-600">{getFieldError('firstName')}</p>
            )}
          </div>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Last Name *
          </label>
          <div className="mt-1 relative">
            <input
              type="text"
              value={person.lastName}
              onChange={(e) => handleUpdate('lastName', e.target.value)}
              className={`block w-full border rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                getFieldError('lastName') ? 'border-red-300' : 'border-gray-300'
              }`}
              placeholder="Last name"
              required
              maxLength={50}
              disabled={autoFillLastName && index > 0 && lastNameFromAbove}
            />
            {person.lastNameUnknown && (
              <div className="flex items-center mt-1">
                <input
                  type="checkbox"
                  checked={person.lastNameUnknown}
                  onChange={(e) => handleUpdate('lastNameUnknown', e.target.checked)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="ml-2 text-sm text-gray-600">Unknown last name</span>
              </div>
            )}
            {getFieldError('lastName') && (
              <p className="mt-1 text-sm text-red-600">{getFieldError('lastName')}</p>
            )}
          </div>
        </div>
      </div>

      {showAdvancedFields && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email (Optional)
            </label>
            <input
              type="email"
              value={person.email || ''}
              onChange={(e) => handleUpdate('email', e.target.value)}
              className={`mt-1 block w-full border rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                getFieldError('email') ? 'border-red-300' : 'border-gray-300'
              }`}
              placeholder="email@example.com"
              maxLength={255}
            />
            {getFieldError('email') && (
              <p className="mt-1 text-sm text-red-600">{getFieldError('email')}</p>
            )}
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Phone (Optional)
            </label>
            <input
              type="tel"
              value={person.phone || ''}
              onChange={(e) => handleUpdate('phone', e.target.value)}
              className={`mt-1 block w-full border rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                getFieldError('phone') ? 'border-red-300' : 'border-gray-300'
              }`}
              placeholder="Phone number"
            />
            {getFieldError('phone') && (
              <p className="mt-1 text-sm text-red-600">{getFieldError('phone')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PersonForm;
