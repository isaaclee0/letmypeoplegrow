# Simplified Database Migration Guide

Based on your existing database dump, most schema updates are already in place. This guide only adds the missing pieces.

## ⚠️ IMPORTANT: Backup First!

**Before running any commands, create a full backup of your database!**

## What's Already There ✅

Your database already has:
- ✅ `church_id` columns in all major tables
- ✅ `last_login_at` column in users table
- ✅ All basic table structures

## What's Missing ❌

Based on the current codebase, you need to add:

### 1. Add Missing Columns to `gathering_types` Table

```sql
-- Add attendance_type column for headcount support
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS attendance_type ENUM('standard', 'headcount') DEFAULT 'standard' 
AFTER frequency;

-- Add custom_schedule column for custom scheduling
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS custom_schedule JSON DEFAULT NULL 
AFTER attendance_type;

-- Add index for attendance_type
ALTER TABLE gathering_types 
ADD INDEX IF NOT EXISTS idx_attendance_type (attendance_type);
```

### 2. Add Missing Column to `individuals` Table

```sql
-- Add is_visitor column
ALTER TABLE individuals 
ADD COLUMN IF NOT EXISTS is_visitor BOOLEAN DEFAULT false 
AFTER is_active;

-- Add index for is_visitor
ALTER TABLE individuals 
ADD INDEX IF NOT EXISTS idx_is_visitor (is_visitor);
```

### 3. Create Missing Tables

#### 3.1 Create `headcount_records` Table
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

#### 3.2 Create `visitor_config` Table
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

### 4. Insert Default Visitor Configuration

```sql
-- Insert default visitor configuration for your existing church
INSERT IGNORE INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
SELECT DISTINCT church_id, 6, 2 
FROM users 
WHERE church_id IS NOT NULL;
```

## Verification

Run these commands to verify everything was added correctly:

```sql
-- Check if new columns exist
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'gathering_types' AND COLUMN_NAME IN ('attendance_type', 'custom_schedule');

SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'individuals' AND COLUMN_NAME = 'is_visitor';

-- Check if new tables exist
SHOW TABLES LIKE 'headcount_records';
SHOW TABLES LIKE 'visitor_config';

-- Check visitor config was created
SELECT * FROM visitor_config;
```

## That's It! 🎉

This simplified migration only adds the 4 missing pieces:
1. **`attendance_type`** and **`custom_schedule`** columns to `gathering_types`
2. **`is_visitor`** column to `individuals` 
3. **`headcount_records`** table
4. **`visitor_config`** table with default settings

Everything else is already in your database!
