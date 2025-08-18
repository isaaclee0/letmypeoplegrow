# People Management System Documentation

## Overview

The people management system handles three types of people:
- **Regular attendees**: Permanent church members
- **Local visitors**: People from the local area who may become regular attendees  
- **Traveller visitors**: People visiting from out of town

## File Structure

### AttendancePage.tsx (2,703 lines)
- Primary purpose: Take attendance for church services
- Secondary purpose: Add visitors during services
- Key features: Real-time attendance tracking, visitor management, family grouping

### PeoplePage.tsx (3,167 lines)
- Primary purpose: Comprehensive people and family management
- Key features: CRUD operations, bulk editing, CSV import, merging, archiving

## Core Data Structures

```typescript
interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
  lastAttendanceDate?: string;
  gatheringAssignments?: Array<{id: number, name: string}>;
}

interface Family {
  id: number;
  familyName: string;
  memberCount: number;
  familyType?: 'regular' | 'local_visitor' | 'traveller_visitor';
  lastAttended?: string;
}
```

## AttendancePage.tsx - Key People Management Features

### 1. Visitor Addition System

**Visitor Form State:**
```typescript
interface VisitorFormState {
  personType: 'regular' | 'local_visitor' | 'traveller_visitor';
  notes: string;
  persons: PersonForm[];
  autoFillSurname: boolean;
}
```

**Key Functions:**
- `addPerson()` - Add new person to form
- `removePerson(index)` - Remove person from form
- `updatePerson(index, updates)` - Update person data with auto-fill logic
- `generateFamilyName(people)` - Generate family name from people array
- `handleSubmitVisitor()` - Submit visitor data to API

**Family Name Generation Logic:**
- Single person: "SURNAME, firstname"
- Multiple people: "SURNAME, firstname and firstname"
- Unknown surnames: "firstname and firstname"
- Mixed surnames: "SURNAME1, firstname1 and SURNAME2, firstname2"

### 2. Visitor Editing System

**Edit Visitor Flow:**
1. Parse existing visitor name into individual people
2. Populate form with current data
3. Allow editing of all fields
4. Submit updates via API

### 3. Quick Add from Recent Visitors

**Function:** `quickAddRecentVisitor(recentVisitor)`
- Parses visitor name into people array
- Creates visitor family in People system
- Adds family to current service
- Shows success message

## PeoplePage.tsx - Comprehensive Management

### 1. Data Loading and State Management

**Key Loading Functions:**
- `loadPeople()` - Load all people with duplicate detection
- `loadFamilies()` - Load all families
- `loadArchivedPeople()` - Load archived people
- `loadGatheringTypes()` - Load gathering types

### 2. Family Grouping System

**Grouping Logic:**
```typescript
// Group regular attendees by family
const groupedPeople = people.reduce((groups, person) => {
  if (person.peopleType !== 'regular') return groups;
  if (person.familyId && person.familyName) {
    // Group by family
  } else {
    // List as individuals
  }
  return groups;
}, {});

// Separate grouping for visitors
const groupedVisitors = useMemo(() => {
  return people.reduce((groups, person) => {
    if (person.peopleType !== 'local_visitor' && person.peopleType !== 'traveller_visitor') {
      return groups;
    }
    // Group visitors by family
  }, {});
}, [people]);
```

### 3. Family Management System

**Family Name Generation:**
```typescript
const generateFamilyName = useCallback((members) => {
  const validMembers = members.filter(m => m.firstName.trim() && m.lastName.trim());
  
  if (validMembers.length === 1) {
    return `${validMembers[0].lastName}, ${validMembers[0].firstName}`;
  }
  
  // Multiple members: "SURNAME, Person1 and Person2"
  const surname = validMembers[0].lastName;
  const firstNames = validMembers.map(m => m.firstName);
  
  try {
    const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
    return `${surname}, ${listFormatter.format(firstNames)}`;
  } catch (error) {
    // Fallback formatting
  }
}, []);
```

**Family Member Management:**
- `addFamilyMember()` - Add new member with auto-surname fill
- `removeFamilyMember(index)` - Remove member
- `updateFamilyMember(index, field, value)` - Update with auto-surname sync

### 4. Individual Person Editing

**Edit Person Flow:**
1. Load person data into editor state
2. Allow editing of name, family, gathering assignments
3. Handle family creation/lookup
4. Sync gathering assignments
5. Update via API

### 5. Bulk Operations

**Mass Edit System:**
```typescript
const [massEdit, setMassEdit] = useState<{
  familyInput: string;
  selectedFamilyId: number | null;
  newFamilyName: string;
  lastName: string;
  peopleType: '' | 'regular' | 'local_visitor' | 'traveller_visitor';
  assignments: { [key: number]: boolean };
  originalAssignments: { [key: number]: Set<number> };
}>();
```

**Mass Edit Handler:**
- Only update changed fields
- Handle family creation/lookup
- Sync gathering assignments
- Apply changes to all selected people

### 6. Family Editor System

**Family Editor State:**
```typescript
const [familyEditor, setFamilyEditor] = useState<{
  familyId: number;
  familyName: string;
  familyType: 'regular' | 'local_visitor' | 'traveller_visitor';
  memberIds: number[];
  addMemberQuery: string;
}>();
```

**Family Editor Features:**
- Edit family name and type
- Add/remove family members
- Search for people to add
- Propagate family type to all members

### 7. CSV Import System

**CSV Upload Handler:**
```typescript
const handleCSVUpload = async () => {
  // Convert CSV data to File object
  const csvBlob = new Blob([csvData], { type: 'text/csv' });
  const csvFile = new File([csvBlob], 'upload.csv', { type: 'text/csv' });
  
  // Upload with optional gathering assignment
  const response = selectedGatheringId 
    ? await csvImportAPI.upload(selectedGatheringId, csvFile)
    : await csvImportAPI.copyPaste(csvData);
    
  // Show results and reload data
};
```

**Expected CSV Format:**
```
FIRST NAME,LAST NAME,FAMILY NAME
John,Smith,"Smith, John and Sarah"
Sarah,Smith,"Smith, John and Sarah"
```

### 8. Merge and Deduplication System

**Merge Individuals into Family:**
```typescript
const handleMergeIndividuals = async () => {
  const response = await familiesAPI.mergeIndividuals({
    individualIds: selectedPeople,
    familyName: mergeData.familyName.trim(),
    familyType: mergeData.familyType,
    mergeAssignments: mergeData.mergeAssignments
  });
};
```

**Merge Families:**
```typescript
const handleMergeFamilies = async () => {
  const response = await familiesAPI.merge({
    keepFamilyId: mergeData.keepFamilyId,
    mergeFamilyIds: mergeData.mergeFamilyIds,
    newFamilyName: mergeData.familyName.trim() || undefined,
    newFamilyType: mergeData.familyType
  });
};
```

**Deduplicate Individuals:**
```typescript
const handleDeduplicateIndividuals = async () => {
  const keepId = dedupeKeepId ?? selectedPeople[0];
  const deleteIds = selectedPeople.filter(id => id !== keepId);
  
  const response = await individualsAPI.deduplicate({
    keepId,
    deleteIds,
    mergeAssignments: mergeData.mergeAssignments
  });
};
```

### 9. Archive and Restore System

**Archive Person:**
```typescript
const archivePerson = async (personId: number) => {
  await individualsAPI.delete(personId); // soft delete
  await loadPeople();
  await loadArchivedPeople();
};
```

**Restore Person:**
```typescript
const restorePerson = async (personId: number) => {
  await individualsAPI.restore(personId);
  await loadPeople();
  await loadArchivedPeople();
};
```

## Key Integration Points

### 1. API Integration
Both components use the same API services:
- `individualsAPI` - individual person operations
- `familiesAPI` - family operations  
- `attendanceAPI` - attendance-related operations
- `csvImportAPI` - bulk import operations

### 2. State Synchronization
- AttendancePage polls every 20 seconds
- PeoplePage reloads after operations
- Both maintain local state for optimistic updates

### 3. Family Name Consistency
Both components use identical family name generation:
- Format: "SURNAME, firstname and firstname"
- Handles unknown surnames
- Supports internationalization

### 4. Permission System
- Attendance takers: limited editing (locked after 2 weeks)
- Admins/coordinators: full access
- Different person types have different capabilities

## UI/UX Patterns

### 1. Modal System
- Fixed positioning with backdrop
- Consistent styling and animations
- Proper focus management

### 2. Form Validation
- Real-time validation with error messages
- Required field indicators
- Conditional field visibility

### 3. Bulk Operations
- Multi-select with checkboxes
- Floating action buttons
- Confirmation dialogs

### 4. Search and Filtering
- Real-time search across names and families
- Gathering-based filtering
- Visitor type filtering

## Error Handling

### 1. API Error Handling
```typescript
try {
  // API call
} catch (err: any) {
  setError(err.response?.data?.error || 'Failed to perform operation');
}
```

### 2. Validation Errors
- Form-level validation before API calls
- User-friendly error messages
- Graceful fallbacks

### 3. Loading States
- Loading spinners during operations
- Disabled buttons during processing
- Optimistic updates with rollback

## Performance Considerations

### 1. Memoization
- Heavy computations use useMemo
- Callback functions use useCallback
- Prevents unnecessary re-renders

### 2. Polling Optimization
- AttendancePage uses refs to avoid stale closures
- Polling paused during user operations
- Cleanup intervals on unmount

### 3. Data Deduplication
- PeoplePage deduplicates by ID
- Development-only duplicate detection
- Efficient data structures

## Summary

This comprehensive people management system provides:

1. **AttendancePage.tsx**: Quick visitor addition during services with family grouping
2. **PeoplePage.tsx**: Full CRUD operations with bulk management capabilities
3. **Consistent Data Models**: Shared interfaces and validation logic
4. **Robust Error Handling**: Graceful failure modes and user feedback
5. **Performance Optimization**: Memoization and efficient data structures
6. **Flexible Import/Export**: CSV upload and copy-paste functionality
7. **Advanced Operations**: Merging, deduplication, and archiving

The system seamlessly integrates attendance tracking with comprehensive people management, providing churches with a complete solution for managing their congregation data.
