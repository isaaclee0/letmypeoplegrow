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
 * Format: "SURNAME, Person1" for single person or "SURNAME, Person1 and Person2" for multiple people
 * For visitors with unknown surnames, format: "Person1" or "Person1 and Person2" (first names only)
 * Note: Only the first two people's names are included for consistency, regardless of family size
 * 
 * @param people Array of people with firstName and lastName
 * @returns Formatted family name string
 */
export const generateFamilyName = (people: PersonForFamilyName[]): string => {
  // Filter people with valid first names
  const peopleWithFirstNames = people.filter(person => 
    person.firstName.trim() && !person.firstUnknown
  );
  
  if (peopleWithFirstNames.length === 0) {
    return '';
  }
  
  // Filter people with both valid first and last names (traditional format)
  const validPeople = peopleWithFirstNames.filter(person => 
    person.lastName.trim() && !person.lastUnknown
  );
  
  // If we have people with known surnames, use traditional format
  if (validPeople.length > 0) {
    if (validPeople.length === 1) {
      return `${validPeople[0].lastName}, ${validPeople[0].firstName}`;
    }
    
    // Multiple people with surnames: "SURNAME, Person1 and Person2" (limit to first two people)
    const surname = validPeople[0].lastName;
    const firstNames = validPeople.slice(0, 2).map(person => person.firstName);
    
    // Use Intl.ListFormat for better internationalization support
    try {
      const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
      const formattedNames = listFormatter.format(firstNames);
      return `${surname}, ${formattedNames}`;
    } catch (error) {
      // Fallback to manual formatting if Intl.ListFormat is not supported
      if (firstNames.length === 1) {
        return `${surname}, ${firstNames[0]}`;
      } else {
        return `${surname}, ${firstNames[0]} and ${firstNames[1]}`;
      }
    }
  }
  
  // No people with known surnames - use first names only (for visitors with unknown surnames)
  if (peopleWithFirstNames.length === 1) {
    return peopleWithFirstNames[0].firstName;
  }
  
  // Multiple people with only first names known: "Person1 and Person2" (limit to first two)
  const firstNames = peopleWithFirstNames.slice(0, 2).map(person => person.firstName);
  
  try {
    const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
    return listFormatter.format(firstNames);
  } catch (error) {
    // Fallback to manual formatting if Intl.ListFormat is not supported
    return `${firstNames[0]} and ${firstNames[1]}`;
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
