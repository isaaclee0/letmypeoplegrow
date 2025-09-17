# Database Migration Guide for Let My People Grow

This guide provides step-by-step SQL commands to update your live database to match the current schema requirements.

## ⚠️ IMPORTANT: Backup First!

**Before running any of these commands, create a full backup of your database!**

```sql
-- Create a backup (run this first)
CREATE DATABASE church_attendance_backup_$(date +%Y%m%d);
-- Then export your current data to the backup database
```

## Step 1: Add Missing Columns to Existing Tables

### 1.1 Update `users` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER id;

-- Add last_login_at column if it doesn't exist
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS last_login_at DATETIME NULL 
AFTER updated_at;

-- Add indexes for church_id
ALTER TABLE users 
ADD INDEX IF NOT EXISTS idx_church_id (church_id);
```

### 1.2 Update `gathering_types` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER created_by;

-- Add attendance_type column if it doesn't exist
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS attendance_type ENUM('standard', 'headcount') DEFAULT 'standard' 
AFTER frequency;

-- Add custom_schedule column if it doesn't exist
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS custom_schedule JSON DEFAULT NULL 
AFTER attendance_type;

-- Add indexes
ALTER TABLE gathering_types 
ADD INDEX IF NOT EXISTS idx_church_id (church_id),
ADD INDEX IF NOT EXISTS idx_attendance_type (attendance_type);
```

### 1.3 Update `individuals` table
```sql
-- Add is_visitor column if it doesn't exist
ALTER TABLE individuals 
ADD COLUMN IF NOT EXISTS is_visitor BOOLEAN DEFAULT false 
AFTER is_regular_attendee;

-- Add index for is_visitor
ALTER TABLE individuals 
ADD INDEX IF NOT EXISTS idx_is_visitor (is_visitor);
```

### 1.4 Update `attendance_sessions` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE attendance_sessions 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER updated_at;

-- Add index for church_id
ALTER TABLE attendance_sessions 
ADD INDEX IF NOT EXISTS idx_church_id (church_id);
```

### 1.5 Update `attendance_records` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE attendance_records 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER updated_at;

-- Add index for church_id
ALTER TABLE attendance_records 
ADD INDEX IF NOT EXISTS idx_church_id (church_id);
```

### 1.6 Update `user_gathering_assignments` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE user_gathering_assignments 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER assigned_at;

-- Add index for church_id
ALTER TABLE user_gathering_assignments 
ADD INDEX IF NOT EXISTS idx_church_id (church_id);
```

### 1.7 Update `user_invitations` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE user_invitations 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER created_at;

-- Add index for church_id
ALTER TABLE user_invitations 
ADD INDEX IF NOT EXISTS idx_church_id (church_id);
```

### 1.8 Update `audit_log` table
```sql
-- Add church_id column if it doesn't exist
ALTER TABLE audit_log 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT 'default' 
AFTER user_agent;

-- Add entity_type column if it doesn't exist
ALTER TABLE audit_log 
ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50) 
AFTER action;

-- Add entity_id column if it doesn't exist
ALTER TABLE audit_log 
ADD COLUMN IF NOT EXISTS entity_id INT 
AFTER entity_type;

-- Add indexes
ALTER TABLE audit_log 
ADD INDEX IF NOT EXISTS idx_church_id (church_id),
ADD INDEX IF NOT EXISTS idx_entity (entity_type, entity_id);
```

## Step 2: Create Missing Tables

### 2.1 Create `headcount_records` table
```sql
CREATE TABLE IF NOT EXISTS headcount_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  headcount INT NOT NULL DEFAULT 0,
  updated_by INT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session_headcount (session_id),
  INDEX idx_church_id (church_id),
  INDEX idx_updated_by (updated_by)
) ENGINE=InnoDB;
```

### 2.2 Create `visitor_config` table
```sql
CREATE TABLE IF NOT EXISTS visitor_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(36) NOT NULL,
  local_visitor_service_limit INT NOT NULL DEFAULT 6,
  traveller_visitor_service_limit INT NOT NULL DEFAULT 2,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_church_config (church_id),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;
```

## Step 3: Update Data for Existing Records

### 3.1 Handle existing church_ids
```sql
-- First, let's see what church_ids already exist
SELECT DISTINCT church_id, COUNT(*) as count FROM users GROUP BY church_id;

-- If you have existing church_ids, use them. If not, we'll create a default one.
-- This will set any NULL or 'default' church_ids to the first existing church_id
UPDATE users 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;
```

### 3.2 Set church_id for other tables based on existing data
```sql
-- Update gathering_types to match users' church_ids
UPDATE gathering_types 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;

-- Update attendance_sessions to match users' church_ids
UPDATE attendance_sessions 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;

-- Update attendance_records to match users' church_ids
UPDATE attendance_records 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;

-- Update user_gathering_assignments to match users' church_ids
UPDATE user_gathering_assignments 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;

-- Update user_invitations to match users' church_ids
UPDATE user_invitations 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;

-- Update audit_log to match users' church_ids
UPDATE audit_log 
SET church_id = (SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL AND church_id != 'default' LIMIT 1)
WHERE church_id = 'default' OR church_id IS NULL;
```

### 3.3 Insert default visitor configuration for all existing churches
```sql
-- Insert default visitor configuration for all existing churches
INSERT IGNORE INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
SELECT DISTINCT church_id, 6, 2 
FROM users 
WHERE church_id IS NOT NULL AND church_id != 'default';
```

## Step 4: Verify the Migration

### 4.1 Check table structures
```sql
-- Verify all tables exist and have correct columns
SHOW TABLES;

-- Check specific table structures
DESCRIBE users;
DESCRIBE gathering_types;
DESCRIBE individuals;
DESCRIBE attendance_sessions;
DESCRIBE attendance_records;
DESCRIBE headcount_records;
DESCRIBE visitor_config;
```

### 4.2 Check indexes
```sql
-- Verify indexes exist
SHOW INDEX FROM users WHERE Key_name LIKE 'idx_%';
SHOW INDEX FROM gathering_types WHERE Key_name LIKE 'idx_%';
SHOW INDEX FROM individuals WHERE Key_name LIKE 'idx_%';
SHOW INDEX FROM attendance_sessions WHERE Key_name LIKE 'idx_%';
SHOW INDEX FROM attendance_records WHERE Key_name LIKE 'idx_%';
SHOW INDEX FROM audit_log WHERE Key_name LIKE 'idx_%';
```

## Step 5: Verify Migration Success

### 5.1 Test key functionality
```sql
-- Verify church_id is properly set
SELECT COUNT(*) as users_with_church_id FROM users WHERE church_id != 'default';

-- Check if new tables exist
SELECT COUNT(*) as headcount_records_count FROM headcount_records;
SELECT COUNT(*) as visitor_config_count FROM visitor_config;

-- Verify new columns exist
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'users' AND COLUMN_NAME IN ('church_id', 'last_login_at');

SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'gathering_types' AND COLUMN_NAME IN ('church_id', 'attendance_type', 'custom_schedule');
```

## Notes

1. **No manual church_id replacement needed** - the migration automatically uses existing church_ids
2. **Run commands in order** - some depend on previous steps
3. **Test in a development environment first** if possible
4. **Monitor for errors** - if any command fails, check the error and adjust accordingly
5. **The `IF NOT EXISTS` clauses** make the migration safe to run multiple times
6. **The migration preserves existing church_ids** and only updates 'default' or NULL values

## Troubleshooting

If you encounter errors:

1. **Column already exists**: The `IF NOT EXISTS` should prevent this, but if it occurs, skip that step
2. **Foreign key constraints**: Make sure referenced tables exist before creating foreign keys
3. **Index already exists**: The `IF NOT EXISTS` should prevent this
4. **Data type conflicts**: Check existing data types before altering columns

## After Migration

Once the migration is complete:
1. Test your application thoroughly
2. Verify all features work as expected
3. Consider creating a new backup with the updated schema
