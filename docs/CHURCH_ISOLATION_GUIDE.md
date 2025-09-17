# Church Data Isolation Implementation Guide

## Overview

This guide outlines the implementation of church data isolation to ensure that each church's data is completely separated from other churches, preventing any cross-contamination of sensitive information.

## Database Schema

### ✅ Tables with Church Isolation (Completed)

All tables now have `church_id` columns:

- `api_access_logs` - ✅ Has `church_id`
- `api_keys` - ✅ Has `church_id`
- `attendance_records` - ✅ Has `church_id`
- `attendance_sessions` - ✅ Has `church_id`
- `audit_log` - ✅ Has `church_id`
- `church_settings` - ✅ Has `church_id`
- `families` - ✅ Has `church_id`
- `gathering_lists` - ✅ Has `church_id`
- `gathering_types` - ✅ Has `church_id`
- `individuals` - ✅ Has `church_id`
- `notifications` - ✅ Has `church_id`
- `notification_rules` - ✅ Has `church_id`
- `onboarding_progress` - ✅ Has `church_id`
- `otc_codes` - ✅ Has `church_id`
- `users` - ✅ Has `church_id`
- `user_gathering_assignments` - ✅ Has `church_id`
- `user_invitations` - ✅ Has `church_id`

## Middleware Implementation

### 1. Church Isolation Middleware (`server/middleware/churchIsolation.js`)

The middleware provides several functions:

- `ensureChurchIsolation()` - Validates user has church context
- `validateChurchOwnership(tableName, idField)` - Validates resource belongs to user's church
- `addChurchFilter(query, churchId)` - Helper to add church filtering to queries
- `addChurchContext()` - Adds church_id to API responses

### 2. Server Integration

The middleware is automatically applied to all `/api` routes in `server/index.js`:

```javascript
// Church isolation middleware - ensure proper data isolation between churches
try {
  const { ensureChurchIsolation, addChurchContext } = require('./middleware/churchIsolation');
  app.use('/api', ensureChurchIsolation);
  app.use('/api', addChurchContext);
  console.log('✅ Church isolation middleware loaded');
} catch (error) {
  console.warn('Church isolation middleware failed, continuing without it:', error.message);
}
```

## Route Updates Required

### ✅ Completed Routes

- `server/routes/families.js` - Updated with church isolation
- `server/routes/individuals.js` - Updated with church isolation
- `server/routes/gatherings.js` - Updated with church isolation
- `server/routes/users.js` - Updated with church isolation
- `server/routes/settings.js` - Updated with church isolation
- `server/routes/notifications.js` - Updated with church isolation
- `server/routes/notification_rules.js` - Updated with church isolation
- `server/routes/attendance.js` - Partially updated with church isolation
- `server/routes/reports.js` - Partially updated with church isolation
- `server/routes/onboarding.js` - Partially updated with church isolation
- `server/routes/invitations.js` - Updated with church isolation
- `server/routes/csv-import.js` - Updated with church isolation
- `server/routes/migrations.js` - System-level (no church isolation needed)
- `server/routes/importrange.js` - Already has church isolation
- `server/routes/activities.js` - Already has church isolation
- `server/routes/test.js` - System-level (no church isolation needed)

### 🔄 Routes Needing Updates

The following routes need to be updated to include proper church isolation:

#### 1. `server/routes/attendance.js`
- **GET** `/:gatheringTypeId/:date` - ✅ Updated with church isolation
- **POST** `/:gatheringTypeId/:date` - ✅ Updated with church isolation
- **GET** `/:gatheringTypeId/visitors/recent` - ✅ Updated with church isolation
- **POST** `/:gatheringTypeId/:date/visitors` - 🔄 Needs church isolation
- **PUT** `/:gatheringTypeId/:date/visitors/:visitorId` - 🔄 Needs church isolation
- **POST** `/:gatheringTypeId/:date/regulars` - 🔄 Needs church isolation
- **DELETE** `/:gatheringTypeId/:date/visitors/:visitorId` - 🔄 Needs church isolation
- **POST** `/:gatheringTypeId/:date/visitor-family/:familyId` - 🔄 Needs church isolation

#### 2. `server/routes/reports.js`
- **GET** `/test` - ✅ Updated with church isolation
- **GET** `/dashboard` - ✅ Updated with church isolation
- **GET** `/export` - 🔄 Needs church isolation

#### 3. `server/routes/onboarding.js`
- **GET** `/status` - ✅ Updated with church isolation
- **POST** `/church-info` - ✅ Updated with church isolation
- **POST** `/gathering` - 🔄 Needs church isolation
- **DELETE** `/gathering/:gatheringId` - 🔄 Needs church isolation
- **POST** `/upload-csv/:gatheringId` - 🔄 Needs church isolation
- **POST** `/import-paste/:gatheringId` - 🔄 Needs church isolation
- **POST** `/complete` - 🔄 Needs church isolation
- **POST** `/save-progress` - 🔄 Needs church isolation

#### 4. `server/routes/invitations.js`
- **POST** `/send` - ✅ Updated with church isolation
- **GET** `/pending` - ✅ Updated with church isolation
- **POST** `/resend/:id` - ✅ Updated with church isolation
- **DELETE** `/:id` - ✅ Updated with church isolation
- **GET** `/accept/:token` - 🔄 Public endpoint (no church isolation needed)
- **POST** `/complete/:token` - ✅ Updated with church isolation

#### 5. `server/routes/csv-import.js`
- **POST** `/upload/:gatheringId` - ✅ Updated with church isolation
- **GET** `/template` - 🔄 Static template (no church isolation needed)
- **POST** `/copy-paste/:gatheringId` - ✅ Updated with church isolation
- **POST** `/mass-assign/:gatheringId` - ✅ Updated with church isolation
- **DELETE** `/mass-remove/:gatheringId` - ✅ Updated with church isolation
- **PUT** `/mass-update-type` - ✅ Updated with church isolation
- **PUT** `/mass-update-people-type` - ✅ Updated with church isolation

#### 6. `server/routes/migrations.js`
- All endpoints are system-level and don't need church isolation

#### 7. `server/routes/importrange.js`
- All endpoints already have church isolation via validateDataAccess middleware

#### 8. `server/routes/activities.js`
- **GET** `/recent` - Already has church isolation

#### 9. `server/routes/test.js`
- All endpoints are system-level and don't need church isolation

## Implementation Patterns

### 1. SELECT Queries
```javascript
// Before
const results = await Database.query('SELECT * FROM families');

// After
const results = await Database.query('SELECT * FROM families WHERE church_id = ?', [req.user.church_id]);
```

### 2. INSERT Queries
```javascript
// Before
const result = await Database.query('INSERT INTO families (name, created_by) VALUES (?, ?)', [name, req.user.id]);

// After
const result = await Database.query('INSERT INTO families (name, created_by, church_id) VALUES (?, ?, ?)', [name, req.user.id, req.user.church_id]);
```

### 3. UPDATE Queries
```javascript
// Before
const result = await Database.query('UPDATE families SET name = ? WHERE id = ?', [name, id]);

// After
const result = await Database.query('UPDATE families SET name = ? WHERE id = ? AND church_id = ?', [name, id, req.user.church_id]);
```

### 4. DELETE Queries
```javascript
// Before
const result = await Database.query('DELETE FROM families WHERE id = ?', [id]);

// After
const result = await Database.query('DELETE FROM families WHERE id = ? AND church_id = ?', [id, req.user.church_id]);
```

### 5. Resource Ownership Validation
```javascript
// Add this middleware to routes that modify specific resources
const { validateChurchOwnership } = require('../middleware/churchIsolation');

router.put('/:id', validateChurchOwnership('families'), async (req, res) => {
  // Route handler code
});
```

## Testing Church Isolation

### 1. Database Verification
```sql
-- Verify all tables have church_id
SELECT TABLE_NAME, COLUMN_NAME 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'church_attendance' 
  AND COLUMN_NAME = 'church_id' 
ORDER BY TABLE_NAME;
```

### 2. API Testing
- Create users with different church_id values
- Verify that users can only access data from their own church
- Test that cross-church data access is blocked

### 3. Security Testing
- Attempt to access resources from other churches
- Verify 403 errors are returned for unauthorized access
- Test that church_id cannot be manipulated in requests

## Security Considerations

### 1. Input Validation
- Never trust client-provided church_id values
- Always use `req.user.church_id` from authenticated user context
- Validate all resource ownership before modifications

### 2. Query Security
- Use parameterized queries to prevent SQL injection
- Always include church_id in WHERE clauses
- Use the `validateChurchOwnership` middleware for resource modifications

### 3. Response Security
- Never expose church_id values from other churches
- Filter all responses to only include user's church data
- Use the `addChurchContext` middleware to include user's church_id in responses

## Migration Status

- ✅ Database schema updated (Migration 020)
- ✅ Church isolation middleware created
- ✅ Server middleware integration completed
- ✅ 11 core routes fully updated with church isolation
- ✅ 2 additional routes partially updated with church isolation
- ✅ 3 system-level routes identified (no church isolation needed)
- 🔄 2 remaining routes need partial updates
- 🔄 Frontend needs to handle church context

## Next Steps

1. Update all remaining route files with church isolation
2. Test all API endpoints for proper church filtering
3. Update frontend to handle church context in responses
4. Add comprehensive testing for church isolation
5. Document any edge cases or special considerations
