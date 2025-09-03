# Family Display Issue Fix

## Problem Description

The family "Chloe and Fin" with member "Fin Unknown" appears in Sunday service attendance but does not appear in the People view. This is a data consistency issue caused by inactive family members.

## Root Cause

The issue occurs when a family has members that are marked as inactive (`is_active = false`) in the database:

1. **Families API** (`/families`): Shows families even if they have no active members
2. **Individuals API** (`/individuals`): Only shows active individuals (`WHERE i.is_active = true`)
3. **People view**: Uses the Individuals API, so it doesn't show inactive individuals
4. **Attendance view**: Shows families because they appear in attendance records (which may include inactive individuals)

## Solution Implemented

### 1. Fixed Families API Query

**Before:**
```sql
FROM families f
LEFT JOIN individuals i ON f.id = i.family_id AND i.is_active = true
```

**After:**
```sql
FROM families f
JOIN individuals i ON f.id = i.family_id AND i.is_active = true
```

This change ensures that only families with at least one active member are shown in the main families list.

### 2. Added Admin-Only Endpoint

Added `/families/all` endpoint for administrators to view all families (including those with inactive members):

```javascript
// Get all families (including those with inactive members) - Admin only
router.get('/all', requireRole(['admin']), async (req, res) => {
  // Returns families with both active and inactive member counts
});
```

### 3. Updated Frontend API

Added `getAllIncludingInactive()` method to the families API service for admin access.

## How to Fix the Specific Issue

### Option 1: Using the Application UI (Recommended)

1. Go to the **People** page in your application
2. Look for a button that says "Show (X)" where X is the number of archived people
3. Click it to view archived/inactive people
4. Find "Fin Unknown" in the archived list
5. Click the "Restore" button next to their name
6. The family "Chloe and Fin" should now appear in the main People view

### Option 2: Using Database Scripts

#### Step 1: Identify the Issue
Run the diagnostic script:
```bash
node find-inactive-family.js
```

#### Step 2: Fix via SQL
Run the SQL script to find and restore the inactive individual:
```bash
mysql -u your_user -p your_database < fix-inactive-family.sql
```

Then manually restore the individual:
```sql
UPDATE individuals 
SET is_active = true, updated_at = NOW() 
WHERE id = [INDIVIDUAL_ID] AND church_id = [YOUR_CHURCH_ID];
```

## Prevention

To prevent this issue in the future:

1. **Use the application's archive/restore functionality** instead of manually setting database flags
2. **Regularly check archived people** to ensure no families are accidentally hidden
3. **Consider implementing family-level archiving** instead of just individual-level

## Files Modified

1. `server/routes/families.js` - Fixed main families query and added admin endpoint
2. `client/src/services/api.ts` - Added new API method
3. `find-inactive-family.js` - Diagnostic script (new)
4. `fix-inactive-family.sql` - SQL fix script (new)

## Testing

After implementing the fix:

1. Verify that families with only inactive members no longer appear in the main families list
2. Confirm that administrators can still access all families via the new endpoint
3. Test that restoring an inactive individual brings the family back to the main view
4. Ensure that attendance functionality continues to work correctly

## Notes

- The fix maintains backward compatibility
- Existing attendance records are preserved
- The change only affects the display logic, not the underlying data
- Administrators retain full access to all data through the new endpoint
