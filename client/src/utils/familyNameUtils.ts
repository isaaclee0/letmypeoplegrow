/**
 * Utility functions for generating and formatting family names
 */

export interface PersonForFamilyName {
  firstName: string;
  lastName: string;
  firstUnknown?: boolean;
  lastUnknown?: boolean;
  isChild?: boolean;
}

/**
 * Generates a family name from an array of people
 * Format: "SURNAME, Person1 and Person2" or "SURNAME, Person1, Person2 and Person3"
 * 
 * @param people Array of people with firstName and lastName
 * @returns Formatted family name string
 */
export const generateFamilyName = (people: PersonForFamilyName[]): string => {
  // Filter out people with missing required names
  const validPeople = people.filter(person => 
    person.firstName.trim() && 
    person.lastName.trim() &&
    !person.firstUnknown &&
    !person.lastUnknown
  );
  
  if (validPeople.length === 0) {
    return '';
  }
  
  if (validPeople.length === 1) {
    return `${validPeople[0].lastName}, ${validPeople[0].firstName}`;
  }
  
  // Multiple people: "SURNAME, Person1 and Person2" - enhanced for i18n
  const surname = validPeople[0].lastName;
  const firstNames = validPeople.map(person => person.firstName);
  
  // Use Intl.ListFormat for better internationalization support
  try {
    const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
    const formattedNames = listFormatter.format(firstNames);
    return `${surname}, ${formattedNames}`;
  } catch (error) {
    // Fallback to manual formatting if Intl.ListFormat is not supported
    const lastName = firstNames[firstNames.length - 1];
    const otherNames = firstNames.slice(0, -1);
    
    if (otherNames.length === 0) {
      return `${surname}, ${lastName}`;
    } else {
      return `${surname}, ${otherNames.join(', ')} and ${lastName}`;
    }
  }
};

/**
 * Parses a family name back into components
 * Useful for editing existing families
 * 
 * @param familyName The formatted family name
 * @returns Object with surname and first names array
 */
export const parseFamilyName = (familyName: string): { surname: string; firstNames: string[] } => {
  const parts = familyName.split(', ');
  if (parts.length < 2) {
    return { surname: '', firstNames: [] };
  }
  
  const surname = parts[0];
  const namesString = parts.slice(1).join(', ');
  
  // Split on ' and ' and ', ' to get individual names
  const firstNames = namesString
    .split(/ and |, /)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  
  return { surname, firstNames };
};

/**
 * Validates if a family name follows the expected format
 * 
 * @param familyName The family name to validate
 * @returns True if the format is valid
 */
export const isValidFamilyNameFormat = (familyName: string): boolean => {
  if (!familyName || !familyName.includes(', ')) {
    return false;
  }
  
  const parts = familyName.split(', ');
  return parts.length >= 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0;
};

/**
 * Suggests a family name based on the most common surname in a group
 * Useful for merging or bulk operations
 * 
 * @param people Array of people
 * @returns Suggested family name
 */
export const suggestFamilyName = (people: PersonForFamilyName[]): string => {
  if (people.length === 0) return '';
  
  // Count surname frequencies
  const surnameCount = new Map<string, number>();
  people.forEach(person => {
    if (person.lastName.trim() && !person.lastUnknown) {
      const surname = person.lastName.trim();
      surnameCount.set(surname, (surnameCount.get(surname) || 0) + 1);
    }
  });
  
  if (surnameCount.size === 0) return '';
  
  // Find most common surname
  const mostCommonSurname = Array.from(surnameCount.entries())
    .sort(([,a], [,b]) => b - a)[0][0];
  
  // Filter people with the most common surname
  const familyMembers = people.filter(person => 
    person.lastName.trim() === mostCommonSurname &&
    person.firstName.trim() &&
    !person.firstUnknown &&
    !person.lastUnknown
  );
  
  return generateFamilyName(familyMembers);
};
