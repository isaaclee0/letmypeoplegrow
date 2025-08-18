# Shared Utilities and Components

This directory contains shared utilities, components, and hooks that provide consistent functionality across the application.

## Recent Improvements (Based on Code Review)

### 1. Shared Utilities (`utils/`)

#### `familyNameUtils.ts`
- **Purpose**: Centralized family name generation and parsing
- **Key Functions**:
  - `generateFamilyName()`: Creates consistent family names with i18n support
  - `parseFamilyName()`: Extracts components from formatted family names
  - `suggestFamilyName()`: Suggests names based on surname frequency
- **Benefits**: Eliminates code duplication between AttendancePage and PeoplePage

#### `schemas.ts` & `validationUtils.ts`
- **Purpose**: Robust validation using Yup schemas
- **Key Features**:
  - Type-safe validation schemas for all form data
  - Consistent error messages and validation rules
  - Async validation support for complex operations
  - Field-level validation for real-time feedback
- **Benefits**: Replaces ad-hoc validation with standardized, maintainable schemas

#### `constants.ts`
- **Purpose**: Centralized configuration and constants
- **Key Areas**:
  - People types and labels
  - Gathering colors and styling
  - Validation limits and rules
  - Error/success messages
  - Feature flags and UI configuration
- **Benefits**: Single source of truth for configuration, easier maintenance

#### `errorHandling.ts`
- **Purpose**: Consistent error handling across the application
- **Key Features**:
  - Standardized API error processing
  - Error categorization (network, validation, permission, etc.)
  - Retry mechanisms for transient errors
  - Batch error handling for bulk operations
- **Benefits**: Better user experience, easier debugging, consistent error reporting

#### `performanceUtils.ts`
- **Purpose**: Performance optimization for large datasets
- **Key Features**:
  - Virtual scrolling for large lists
  - Optimized pagination and search
  - Batch operations with progress tracking
  - Memory-efficient grouping and filtering
  - Performance monitoring and debugging
- **Benefits**: Scalable for churches with thousands of members

### 2. Shared Components (`components/shared/`)

#### `PersonForm.tsx`
- **Purpose**: Reusable person input form with validation
- **Features**:
  - Real-time validation feedback
  - Auto-fill capabilities
  - Advanced field support (email, phone)
  - Accessibility features
- **Benefits**: Consistent person data entry across different contexts

#### `FamilyNameInput.tsx`
- **Purpose**: Intelligent family name input with auto-generation
- **Features**:
  - Auto-generates names from family members
  - Manual override capability
  - Validation integration
  - Visual feedback for auto-generated vs manual names
- **Benefits**: Reduces user effort while maintaining flexibility

### 3. People Management Components (`components/people/`)

#### `FamilyEditorModal.tsx`
- **Purpose**: Dedicated family editing interface
- **Features**: Member management, family type setting, comprehensive validation

#### `MassEditModal.tsx`
- **Purpose**: Bulk editing interface for multiple people
- **Features**: Selective field updates, gathering assignment management

#### `PersonEditorModal.tsx`
- **Purpose**: Individual person editing interface
- **Features**: Complete person data management, family assignment

#### `AddPeopleModal.tsx`
- **Purpose**: Comprehensive add interface with multiple input methods
- **Features**: Person-by-person entry, CSV upload, copy-paste import

### 4. Custom Hooks (`hooks/`)

#### `usePeopleManagement.ts`
- **Purpose**: Shared state management and operations for people/family data
- **Key Hooks**:
  - `usePeopleData()`: Centralized data loading and management
  - `useSelection()`: Multi-item selection state management
  - `useOptimisticUpdates()`: Optimistic UI updates with rollback
  - `useAsyncOperation()`: Loading states for async operations
  - `useGatheringAssignments()`: Gathering assignment management
  - `useFamilyOperations()`: Family-related operations
- **Benefits**: Consistent patterns, reduced duplication, better state management

## Migration Benefits

### Code Quality Improvements
1. **Modularity**: Large monolithic files broken into focused, reusable components
2. **Maintainability**: Shared utilities eliminate code duplication
3. **Type Safety**: Comprehensive TypeScript schemas and interfaces
4. **Testing**: Smaller, focused components are easier to test
5. **Performance**: Optimized for large datasets with virtual scrolling and batching

### Developer Experience
1. **Consistency**: Standardized patterns across all components
2. **Reusability**: Components and hooks can be easily reused
3. **Documentation**: Clear interfaces and comprehensive typing
4. **Debugging**: Better error handling and performance monitoring
5. **Scalability**: Built to handle growth from small to large churches

### User Experience
1. **Validation**: Real-time, user-friendly validation feedback
2. **Performance**: Responsive interface even with large datasets
3. **Consistency**: Uniform behavior across different parts of the app
4. **Accessibility**: ARIA labels and keyboard navigation support
5. **Error Handling**: Graceful error recovery and user-friendly messages

## Next Steps

1. **Integration**: Update AttendancePage and PeoplePage to use new shared components
2. **Testing**: Add comprehensive unit and integration tests
3. **Documentation**: Complete API documentation for all shared utilities
4. **Performance**: Monitor and optimize based on real-world usage
5. **Accessibility**: Complete accessibility audit and improvements

## Usage Examples

### Using Shared Validation
```typescript
import { validatePerson, personSchema } from '../utils/validationUtils';

const result = validatePerson(personData);
if (!result.isValid) {
  console.log('Errors:', result.errors);
}
```

### Using Family Name Generation
```typescript
import { generateFamilyName } from '../utils/familyNameUtils';

const familyName = generateFamilyName([
  { firstName: 'John', lastName: 'Smith' },
  { firstName: 'Jane', lastName: 'Smith' }
]);
// Result: "Smith, John and Jane"
```

### Using Performance Hooks
```typescript
import { useOptimizedSearch, usePagination } from '../utils/performanceUtils';

const { filteredItems } = useOptimizedSearch(people, ['firstName', 'lastName'], searchTerm);
const { paginatedItems, currentPage, goToPage } = usePagination(filteredItems, 50);
```

This refactoring addresses all the major concerns raised in the code review while maintaining backward compatibility and improving the overall architecture of the application.
