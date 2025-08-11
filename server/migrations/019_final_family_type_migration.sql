-- Migration 019: Final family type migration and snake_case conversion
-- This migration handles the conversion from VARCHAR familyType to ENUM family_type
-- and renames columns to snake_case format

USE church_attendance;

-- ============================================================================
-- PART 1: CONVERT FAMILYTYPE TO NEW ENUM FORMAT
-- ============================================================================

-- Step 1: Create temporary column with new ENUM type
ALTER TABLE families ADD COLUMN family_type_new ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular';

-- Step 2: Migrate existing data
-- All current 'visitor' families have 'local_visitor' members, so convert them accordingly
UPDATE families 
SET family_type_new = 'local_visitor' 
WHERE familyType = 'visitor';

-- Step 3: Set regular families
UPDATE families 
SET family_type_new = 'regular' 
WHERE familyType = 'regular';

-- Step 4: Drop old column and rename new one
ALTER TABLE families DROP COLUMN familyType;
ALTER TABLE families CHANGE COLUMN family_type_new family_type ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular';

-- ============================================================================
-- PART 2: SNAKE_CASE CONVERSION
-- ============================================================================

-- Step 5: Rename lastAttended to last_attended
ALTER TABLE families CHANGE COLUMN lastAttended last_attended DATE;

-- ============================================================================
-- PART 3: HANDLE FAMILY_IDENTIFIER MIGRATION
-- ============================================================================

-- Step 6: Add family_notes column if it doesn't exist
SET @notes_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() 
    AND table_name = 'families' 
    AND column_name = 'family_notes'
);

SET @sql = IF(@notes_exists = 0,
  'ALTER TABLE families ADD COLUMN family_notes TEXT AFTER family_name',
  'SELECT "family_notes column already exists"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 7: Migrate notes from family_identifier (if in format "type:notes")
UPDATE families
SET family_notes = SUBSTRING_INDEX(family_identifier, ':', -1)
WHERE family_identifier LIKE '%:%'
  AND (family_notes IS NULL OR family_notes = '');

-- Step 8: Drop family_identifier column and its index
SET @identifier_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() 
    AND table_name = 'families' 
    AND column_name = 'family_identifier'
);

SET @sql = IF(@identifier_exists > 0,
  'ALTER TABLE families DROP COLUMN family_identifier',
  'SELECT "family_identifier column does not exist"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop the index if it exists
SET @index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() 
    AND table_name = 'families' 
    AND index_name = 'idx_identifier'
);

SET @sql = IF(@index_exists > 0,
  'DROP INDEX idx_identifier ON families',
  'SELECT "idx_identifier index does not exist"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- PART 4: RECREATE INDEXES
-- ============================================================================

-- Step 9: Create indexes for the new column names
CREATE INDEX idx_family_type ON families (family_type);
CREATE INDEX idx_last_attended ON families (last_attended);

-- ============================================================================
-- PART 5: VERIFICATION
-- ============================================================================

-- Optional: Verify the migration worked correctly
-- SELECT family_type, COUNT(*) FROM families GROUP BY family_type;
-- SHOW COLUMNS FROM families;

-- End migration 019
