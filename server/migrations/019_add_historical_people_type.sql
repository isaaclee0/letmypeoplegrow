-- Migration 019: Add historical people_type tracking to attendance_records
-- This allows historical attendance to show the person's type at the time of attendance,
-- even if their type has changed since then.
-- 
-- This migration is SAFE and NON-DESTRUCTIVE:
-- - Only adds new columns (does not modify existing data)
-- - Uses IF NOT EXISTS checks to prevent errors if already applied
-- - Existing records will have NULL for new columns (backward compatible)

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

-- Note: Existing records will have NULL for people_type_at_time.
-- The application code will fall back to current people_type for backward compatibility.

