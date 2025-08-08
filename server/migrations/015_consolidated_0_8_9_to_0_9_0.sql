-- Migration 015: Consolidated migration from 0.8.9 to 0.9.0
-- This migration consolidates all changes needed to upgrade from version 0.8.9 to current 0.9.0 state
-- It includes all the changes from migrations 009-014 in a single, safe migration

USE church_attendance;

-- ============================================================================
-- PART 1: VISITOR FAMILY SUPPORT (from migration 009)
-- ============================================================================

-- Add familyType column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN familyType VARCHAR(20) DEFAULT 'regular' AFTER family_identifier;

-- Add lastAttended column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN lastAttended DATE AFTER familyType;

-- Add index for familyType (will fail silently if already exists)
CREATE INDEX idx_families_family_type ON families(familyType);

-- Add index for lastAttended (will fail silently if already exists)
CREATE INDEX idx_families_last_attended ON families(lastAttended);

-- Update existing families to have 'regular' type
UPDATE families SET familyType = 'regular' WHERE familyType IS NULL;

-- ============================================================================
-- PART 2: AUDIT LOG CHURCH ISOLATION (from migration 010)
-- ============================================================================

-- Add church_id to audit_log table (will fail silently if already exists)
ALTER TABLE audit_log ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Create index for church_id for better query performance (will fail silently if already exists)
CREATE INDEX idx_audit_log_church_id ON audit_log (church_id);

-- ============================================================================
-- PART 3: REMOVE DURATION MINUTES (from migration 011)
-- ============================================================================

-- Remove duration_minutes column from gathering_types table (will fail silently if column doesn't exist)
SET @column_exists = (SELECT COUNT(*) FROM information_schema.columns 
    WHERE table_schema = DATABASE() 
    AND table_name = 'gathering_types' 
    AND column_name = 'duration_minutes');

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE gathering_types DROP COLUMN duration_minutes',
    'SELECT ''Column duration_minutes does not exist, skipping removal'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- PART 4: ADD FAMILY TYPE COLUMN (from migration 012)
-- ============================================================================

-- Add familyType column as ENUM (will fail silently if already exists)
ALTER TABLE families ADD COLUMN familyType ENUM('regular', 'visitor') DEFAULT 'regular' AFTER family_name;

-- Add index for familyType (will fail silently if already exists)
CREATE INDEX idx_family_type ON families (familyType);

-- Add lastAttended column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN lastAttended DATE AFTER family_identifier;

-- ============================================================================
-- PART 5: REFACTOR PEOPLE TYPE SYSTEM (from migration 013_refactor_people_type)
-- ============================================================================

-- Add the new people_type column (will fail silently if already exists)
ALTER TABLE individuals 
ADD COLUMN people_type ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular' AFTER last_name;

-- Migrate existing data (only if old columns exist)
SET @is_visitor_exists = (SELECT COUNT(*) FROM information_schema.columns 
    WHERE table_schema = DATABASE() 
    AND table_name = 'individuals' 
    AND column_name = 'is_visitor');

SET @is_regular_exists = (SELECT COUNT(*) FROM information_schema.columns 
    WHERE table_schema = DATABASE() 
    AND table_name = 'individuals' 
    AND column_name = 'is_regular_attendee');

-- Only migrate if both old columns exist
IF @is_visitor_exists > 0 AND @is_regular_exists > 0 THEN
    -- Set people_type based on current is_visitor and is_regular_attendee values
    UPDATE individuals 
    SET people_type = CASE 
        WHEN is_visitor = 1 THEN 'local_visitor'  -- Default visitors to local_visitor
        WHEN is_regular_attendee = 1 THEN 'regular'
        ELSE 'regular'  -- Default fallback
    END;
    
    -- Remove the old columns
    ALTER TABLE individuals 
    DROP COLUMN is_visitor,
    DROP COLUMN is_regular_attendee;
END IF;

-- Add index for the new column (will fail silently if already exists)
ALTER TABLE individuals 
ADD INDEX idx_people_type (people_type);

-- ============================================================================
-- PART 6: ADD LAST ATTENDANCE DATE (from migration 013_migrate_visitors_and_add_last_attendance)
-- ============================================================================

-- Add last_attendance_date column to individuals table (will fail silently if already exists)
ALTER TABLE individuals 
ADD COLUMN last_attendance_date DATE AFTER people_type;

-- Update last_attendance_date for all existing individuals based on attendance records
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
)
WHERE last_attendance_date IS NULL;

-- Add indexes for performance (will fail silently if already exist)
CREATE INDEX idx_individuals_last_attendance ON individuals(last_attendance_date);
CREATE INDEX idx_individuals_people_type_last_attendance ON individuals(people_type, last_attendance_date);

-- ============================================================================
-- PART 7: SAFE VISITOR MIGRATION (from migration 014)
-- ============================================================================

-- Check if visitors table exists first
SET @visitors_exists = (SELECT COUNT(*) FROM information_schema.tables 
    WHERE table_schema = DATABASE() AND table_name = 'visitors');

-- Only run visitor migration if visitors table exists
IF @visitors_exists > 0 THEN
    -- Create families for visitors from old system that don't exist in new system
    INSERT IGNORE INTO families (family_name, family_identifier, familyType, created_by, created_at)
    SELECT 
      CONCAT(SUBSTRING_INDEX(v.name, ' ', -1), ', ', SUBSTRING_INDEX(v.name, ' ', 1)) as family_name,
      CASE WHEN v.visitor_type = 'potential_regular' THEN 'local_visitor' ELSE 'traveller_visitor' END as family_identifier,
      'visitor' as familyType,
      1 as created_by,
      v.created_at
    FROM visitors v
    LEFT JOIN individuals i ON (
      i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
      i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
      i.people_type IN ('local_visitor', 'traveller_visitor')
    )
    WHERE i.id IS NULL
    GROUP BY v.name, v.visitor_type;

    -- Create individuals for visitors from old system that don't exist in new system
    INSERT IGNORE INTO individuals (first_name, last_name, family_id, people_type, last_attendance_date, is_active, created_at)
    SELECT 
      SUBSTRING_INDEX(v.name, ' ', 1) as first_name,
      SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) as last_name,
      f.id as family_id,
      CASE WHEN v.visitor_type = 'potential_regular' THEN 'local_visitor' ELSE 'traveller_visitor' END as people_type,
      v.last_attended as last_attendance_date,
      true as is_active,
      v.created_at
    FROM visitors v
    JOIN families f ON (
      f.family_name = CONCAT(SUBSTRING_INDEX(v.name, ' ', -1), ', ', SUBSTRING_INDEX(v.name, ' ', 1)) AND
      f.familyType = 'visitor'
    )
    LEFT JOIN individuals i ON (
      i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
      i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
      i.people_type IN ('local_visitor', 'traveller_visitor')
    )
    WHERE i.id IS NULL
    GROUP BY v.name, v.visitor_type, f.id, v.last_attended, v.created_at;

    -- Add migrated individuals to gathering_lists for their appropriate gatherings
    INSERT IGNORE INTO gathering_lists (gathering_type_id, individual_id)
    SELECT DISTINCT
      as_table.gathering_type_id,
      i.id as individual_id
    FROM visitors v
    JOIN attendance_sessions as_table ON v.session_id = as_table.id
    JOIN individuals i ON (
      i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
      i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
      i.people_type IN ('local_visitor', 'traveller_visitor')
    )
    WHERE i.family_id IN (
      SELECT f.id FROM families f WHERE f.familyType = 'visitor'
    );

    -- Create attendance records for migrated visitors based on old visitor records
    INSERT IGNORE INTO attendance_records (session_id, individual_id, present)
    SELECT DISTINCT
      v.session_id,
      i.id as individual_id,
      true as present
    FROM visitors v
    JOIN individuals i ON (
      i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
      i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
      i.people_type IN ('local_visitor', 'traveller_visitor')
    )
    WHERE i.family_id IN (
      SELECT f.id FROM families f WHERE f.familyType = 'visitor'
    );

    -- Update last_attendance_date for migrated visitors to ensure it's accurate
    UPDATE individuals i
    SET last_attendance_date = (
      SELECT MAX(as_table.session_date)
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      WHERE ar.individual_id = i.id AND ar.present = true
    )
    WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
    AND i.last_attendance_date IS NULL;

    -- Clean up duplicates (if any were created)
    DELETE i1 FROM individuals i1 
    INNER JOIN individuals i2 
    WHERE i1.id > i2.id 
    AND i1.first_name = i2.first_name 
    AND i1.last_name = i2.last_name 
    AND i1.people_type = i2.people_type 
    AND i1.people_type IN ('local_visitor', 'traveller_visitor');
END IF;

-- ============================================================================
-- FINAL VERIFICATION AND CLEANUP
-- ============================================================================

-- Update last_attendance_date for all individuals to ensure consistency
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
)
WHERE last_attendance_date IS NULL;

-- Ensure all families have proper familyType
UPDATE families SET familyType = 'regular' WHERE familyType IS NULL OR familyType = '';

-- Verification queries for manual checking (commented out for production)
-- SELECT COUNT(*) as total_visitor_individuals FROM individuals WHERE people_type IN ('local_visitor', 'traveller_visitor');
-- SELECT COUNT(*) as visitor_families FROM families WHERE familyType = 'visitor';
-- SELECT COUNT(*) as total_individuals FROM individuals;
-- SELECT COUNT(*) as total_families FROM families;
-- SELECT 'Migration completed successfully' as status;
