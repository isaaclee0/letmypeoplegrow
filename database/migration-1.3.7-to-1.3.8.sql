-- Migration script from version 1.3.7 to 1.3.8
-- This script can be run directly in phpMyAdmin or via the migration system
-- 
-- ⚠️ IMPORTANT: Backup your database before running this migration!
--
-- Changes included:
-- 1. Historical People Type Tracking - Store people_type at time of attendance
--
-- This migration is SAFE and NON-DESTRUCTIVE:
-- - Only adds new columns (does not modify existing data)
-- - Uses IF NOT EXISTS checks to prevent errors if already applied
-- - Existing records will have NULL for new columns (backward compatible)

-- =====================================================
-- 1. HISTORICAL PEOPLE TYPE TRACKING
-- =====================================================
-- This allows historical attendance to show the person's type at the time of attendance,
-- even if their type has changed since then. This is important for accurate historical reporting.

-- Check if people_type_at_time column exists before adding it
SET @column_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'attendance_records' 
    AND COLUMN_NAME = 'people_type_at_time'
);

-- Add people_type_at_time column if it doesn't exist
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE attendance_records ADD COLUMN people_type_at_time ENUM(\'regular\', \'local_visitor\', \'traveller_visitor\') DEFAULT NULL',
  'SELECT "Column people_type_at_time already exists" as message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check if index exists before adding it
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'attendance_records' 
    AND INDEX_NAME = 'idx_people_type_at_time'
);

-- Add index for faster queries if it doesn't exist
SET @sql = IF(
  @index_exists = 0,
  'CREATE INDEX idx_people_type_at_time ON attendance_records(people_type_at_time)',
  'SELECT "Index idx_people_type_at_time already exists" as message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- 
-- Summary of changes:
-- ✅ Added people_type_at_time column to attendance_records table
-- ✅ Added index for performance optimization
--
-- Notes:
-- - Existing attendance records will have NULL for people_type_at_time
-- - The application code will fall back to current people_type for backward compatibility
-- - New attendance records will automatically store the historical people_type
-- - This enables accurate historical reporting even when people's types change over time
--
-- No data loss or destructive changes were made.
-- All existing functionality remains intact.

