# Naming Conventions

This document establishes the naming conventions used throughout the Let My People Grow application to ensure consistency and prevent future mismatches.

## Database Schema Conventions

### Field Names
- **Use snake_case** for all database column names
- Common field patterns:
  - `first_name`, `last_name` for person names
  - `family_name` for family names  
  - `created_by`, `created_at`, `updated_at` for audit fields
  - `is_active`, `is_visitor` for boolean flags
  - `mobile_number` for phone numbers
  - `primary_contact_method` for contact preferences

### Specific Field Standardization
- **Attendance Sessions**: Use `created_by` (NOT `recorded_by`) to track who created the session
- **User References**: Always use `created_by` for consistency across all tables
- **Foreign Keys**: Use `table_name_id` pattern (e.g., `gathering_type_id`, `user_id`)

## API Response Conventions

### Field Names
- **Use camelCase** for all API response field names
- Automatic conversion from database snake_case to frontend camelCase
- Common field patterns:
  - `firstName`, `lastName` for person names
  - `familyName` for family names
  - `createdBy`, `createdAt`, `updatedAt` for audit fields
  - `isActive`, `isVisitor` for boolean flags
  - `mobileNumber` for phone numbers
  - `primaryContactMethod` for contact preferences

### Response Processing
- Use the `processApiResponse()` utility from `server/utils/caseConverter.js` for all API responses
- This utility automatically:
  - Converts snake_case database fields to camelCase
  - Handles BigInt to Number conversion for JSON serialization
  - Recursively processes nested objects and arrays

## Implementation Guidelines

### For Backend Developers
1. **Database Queries**: Always use snake_case field names in SQL queries
2. **API Responses**: Always use `processApiResponse()` utility before sending responses
3. **New Tables**: Follow the established snake_case naming patterns
4. **Migrations**: Include field name standardization when fixing inconsistencies

### For Frontend Developers
1. **API Interfaces**: Always expect camelCase field names in TypeScript interfaces
2. **Form Data**: Convert camelCase to snake_case when sending data to backend (if needed)
3. **Type Definitions**: Use camelCase in all type definitions

### Example Implementation

#### Database Query
```javascript
const users = await Database.query(`
  SELECT id, first_name, last_name, created_at, is_active
  FROM users 
  WHERE is_active = true
`);
```

#### API Response Processing
```javascript
const { processApiResponse } = require('../utils/caseConverter');

// Convert and send response
const responseData = processApiResponse({ users });
res.json(responseData);
```

#### Frontend Type Definition
```typescript
interface User {
  id: number;
  firstName: string;
  lastName: string;
  createdAt: string;
  isActive: boolean;
}
```

## Migration Strategy

When fixing existing inconsistencies:

1. **Database Schema**: Create migration scripts to standardize field names
2. **Code Updates**: Update all code to use the systematic conversion utility
3. **Testing**: Ensure frontend continues to receive expected camelCase fields
4. **Documentation**: Update this document when adding new patterns

## Common Pitfalls to Avoid

1. **Manual Field Conversion**: Don't manually convert field names in API responses
2. **Inconsistent Field Names**: Don't use different names for the same concept
3. **Missing Conversion**: Don't forget to use `processApiResponse()` in new endpoints
4. **Case Mixing**: Don't mix camelCase and snake_case within the same context

## Tools and Utilities

- **`server/utils/caseConverter.js`**: Systematic conversion between naming conventions
- **Migrations**: Located in `server/migrations/` for schema standardization
- **Type Definitions**: Located in `client/src/services/api.ts`

---

**Last Updated**: Current development cycle  
**Next Review**: When adding new database tables or API endpoints 