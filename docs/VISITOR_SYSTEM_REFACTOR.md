# Visitor System Refactor

## Problem Statement

The current visitor system has several issues:
1. Visitors are stored in a separate `visitors` table with temporary IDs
2. They're not properly integrated with the People/Families system
3. This causes issues with tracking, grouping, and attendance management
4. Visitors can't be properly managed like regular families

## New Approach

### Visitor Addition Flow
1. **Create a new family in People** with type "visitor" and note either "local" or "traveller"
   - Regardless of how many people are added at once, they should be regarded as a family
2. **Add them to the current service** and check them off as present
3. **Update the last service attended value** for this family

### Benefits
- Visitors become proper families in the People system
- They can be tracked consistently across services
- They can be managed like regular families
- The attendance system becomes unified
- No more duplicate keys or undefined IDs

## Implementation Plan

### Frontend Changes (Completed)
1. ✅ Added `createVisitorFamily` API endpoint to `familiesAPI`
2. ✅ Added `addVisitorFamilyToService` API endpoint to `attendanceAPI`
3. ✅ Updated visitor submission logic to create families first
4. ✅ Added `generateFamilyName` helper function
5. ✅ Updated imports to include `familiesAPI`

### Backend Changes Needed

#### 1. New API Endpoint: `POST /api/families/visitor`
```typescript
interface CreateVisitorFamilyRequest {
  familyName: string;
  visitorType: 'local' | 'traveller';
  notes?: string;
  people: Array<{
    firstName: string;
    lastName: string;
    firstUnknown: boolean;
    lastUnknown: boolean;
    isChild: boolean;
  }>;
}

interface CreateVisitorFamilyResponse {
  familyId: number;
  individuals: Array<{
    id: number;
    firstName: string;
    lastName: string;
  }>;
}
```

**Implementation:**
- Create a new family with `familyType = 'visitor'`
- Add a note with the visitor type and any additional notes
- Create individuals for each person in the family
- Return the family ID and created individuals

#### 2. New API Endpoint: `POST /api/attendance/{gatheringId}/{date}/visitor-family/{familyId}`
```typescript
interface AddVisitorFamilyToServiceResponse {
  individuals: Array<{
    id: number;
    firstName: string;
    lastName: string;
    present: boolean;
  }>;
}
```

**Implementation:**
- Add the family to the gathering's attendance list
- Mark all family members as present by default
- Update the family's `lastAttended` date
- Return the individuals with their attendance status

#### 3. Database Schema Changes
```sql
-- Add familyType column to families table
ALTER TABLE families ADD COLUMN familyType VARCHAR(20) DEFAULT 'regular';

-- Add lastAttended column to families table
ALTER TABLE families ADD COLUMN lastAttended DATE;

-- Add index for visitor families
CREATE INDEX idx_families_visitor ON families(familyType) WHERE familyType = 'visitor';
```

#### 4. Update Existing Queries
- Modify attendance queries to include visitor families
- Update family listing queries to handle visitor families
- Ensure visitor families are properly grouped in attendance views

### Migration Strategy

#### Phase 1: Backend Implementation
1. Implement the new API endpoints
2. Add database schema changes
3. Test the new endpoints

#### Phase 2: Frontend Integration
1. ✅ Update visitor addition logic (completed)
2. Update visitor editing logic
3. Update visitor deletion logic
4. Update attendance display to show visitor families

#### Phase 3: Data Migration
1. Create migration script to convert existing visitors to families
2. Test migration on development data
3. Deploy migration to production

#### Phase 4: Cleanup
1. Remove old visitor-specific code
2. Remove old visitor tables (after confirming migration success)
3. Update documentation

## Current Status

- ✅ Frontend changes for new visitor addition flow
- ✅ Backend API endpoints implemented
- ✅ Database schema changes added
- ✅ Migration created
- ✅ Test script created

## Implementation Completed

### Backend Changes (Completed)
1. ✅ **New Migration**: `009_add_visitor_family_support.sql` - Adds `familyType` and `lastAttended` columns to families table
2. ✅ **New API Endpoint**: `POST /api/families/visitor` - Creates visitor families in the People system
3. ✅ **New API Endpoint**: `POST /api/attendance/{gatheringId}/{date}/visitor-family/{familyId}` - Adds visitor families to services
4. ✅ **Updated Attendance Query**: Modified to include visitor families in attendance lists
5. ✅ **Updated Filtering Logic**: Handles both old visitors and new visitor families

### Database Schema Changes (Completed)
```sql
-- Added familyType column to families table
ALTER TABLE families ADD COLUMN familyType VARCHAR(20) DEFAULT 'regular';

-- Added lastAttended column to families table  
ALTER TABLE families ADD COLUMN lastAttended DATE;

-- Added indexes for performance
CREATE INDEX idx_families_visitor ON families(familyType) WHERE familyType = 'visitor';
CREATE INDEX idx_families_last_attended ON families(lastAttended);
```

### Testing (Completed)
- ✅ Created test script: `test-visitor-family-api.js`
- ✅ Tests the complete flow: create family → add to service → verify attendance

## Next Steps

1. **Run Migration**: Execute the new migration to add visitor family support
2. **Test End-to-End**: Use the test script to verify the new system works
3. **Deploy**: Deploy the changes to production
4. **Data Migration**: Plan migration of existing visitors to the new system (optional)
5. **Cleanup**: Remove old visitor-specific code once migration is complete 