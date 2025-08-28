# Church ID Generation Fix

## Issue Identified

The church ID generation was not following the expected pattern. When creating a church called "enjoy church", the system generated `enjoychurch` instead of the expected format `enj_randomchars`.

## Root Cause

The `generateSimpleChurchId` function in `server/utils/churchIdGenerator.js` was using an old logic that:
1. Took up to 20 characters from the church name
2. Added a numeric counter (e.g., `enjoychurch`, `enjoychurch2`, etc.)

This didn't match the documented format which should be:
- **Development**: `{3-letter-prefix}_{6-char-hex}` (e.g., `enj_abc123`)
- **Production**: `{3-letter-prefix}_{12-char-hex}` (e.g., `enj_abc123def456`)

## Fix Applied

### 1. Updated `generateSimpleChurchId` function

**Before:**
```javascript
let baseId = churchName.toLowerCase()
  .replace(/[^a-z0-9]/g, '')
  .substring(0, 20); // Take up to 20 characters

// Add counter logic...
finalId = `${baseId}${counter}`;
```

**After:**
```javascript
const baseId = churchName.toLowerCase()
  .replace(/[^a-z0-9]/g, '')
  .substring(0, 3); // Take only first 3 characters

const randomSuffix = crypto.randomBytes(3).toString('hex'); // 6 char hex
const developmentId = `${finalBaseId}_${randomSuffix}`;
```

### 2. Updated validation patterns

Added support for the new format while maintaining backwards compatibility:
```javascript
// New format: 3 chars + underscore + 6 hex chars
const simplePattern = /^[a-z0-9]{3}_[a-f0-9]{6}$/;

// Legacy format (for backwards compatibility)
const legacyPattern = /^[a-z0-9]{1,20}\d*$/;
```

### 3. Updated examples and comments

- Fixed documentation to show correct format examples
- Updated function comments to reflect actual behavior

## Migration Script

Created `update-church-id.js` and Docker wrapper `docker-update-church-id.sh` to update existing churches with incorrect IDs:

### Docker Usage (Recommended)
```bash
./docker-update-church-id.sh "enjoychurch" "enjoy church"
```

### Manual Docker Command
```bash
docker-compose -f docker-compose.dev.yml exec server node update-church-id.js "enjoychurch" "enjoy church"
```

This script:
1. Generates a new properly-formatted church ID
2. Updates all tables with foreign key references to church_id
3. Uses database transactions for data integrity
4. Requires confirmation before proceeding
5. Runs inside the Docker container with database access

## Usage

### For New Churches
New churches will automatically get the correct format:
- **"Enjoy Church"** → `enj_abc123` (development)
- **"Enjoy Church"** → `enj_abc123def456` (production)

### For Existing Churches
Run the migration script to fix existing churches:

```bash
# Example for your "enjoy church" (Docker wrapper - recommended)
./docker-update-church-id.sh "enjoychurch" "enjoy church"

# Or manually with docker-compose
docker-compose -f docker-compose.dev.yml exec server node update-church-id.js "enjoychurch" "enjoy church"
```

## Tables Updated by Migration

The migration script updates these tables in dependency order:
- `api_access_logs`
- `api_keys`
- `attendance_records` 
- `attendance_sessions`
- `audit_log`
- `families`
- `gathering_lists`
- `gathering_types`
- `individuals`
- `notifications`
- `notification_rules`
- `onboarding_progress`
- `otc_codes`
- `user_gathering_assignments`
- `user_invitations`
- `users`
- `church_settings`

## Verification

After running the migration, you can verify the new ID:

```sql
SELECT church_id, church_name FROM church_settings WHERE church_name = 'enjoy church';
```

Should show something like: `enj_abc123` instead of `enjoychurch`

## Security Benefits

The new format provides:
1. **Consistent length**: All IDs follow predictable pattern
2. **Random suffixes**: Harder to guess other church IDs
3. **Better validation**: Easier to validate format programmatically
4. **Environment awareness**: Different security levels for dev vs prod

## Backwards Compatibility

The system maintains backwards compatibility by:
1. Accepting both old and new formats in validation
2. Not breaking existing churches with old format IDs
3. Migration script allows voluntary updates
