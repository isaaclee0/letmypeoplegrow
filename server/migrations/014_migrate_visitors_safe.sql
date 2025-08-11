-- Migration 014: Safe migration for visitors system (with IF NOT EXISTS checks)
-- This migration will safely handle the visitor migration with proper error handling

-- Step 1: Update last_attendance_date for all existing individuals based on attendance records
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
)
WHERE last_attendance_date IS NULL;

-- Step 2: Create families for visitors from old system that don't exist in new system
-- Check if visitors table exists first
SET @visitors_exists = (SELECT COUNT(*) FROM information_schema.tables 
    WHERE table_schema = DATABASE() AND table_name = 'visitors');

-- Only run if visitors table exists
SET @sql = IF(@visitors_exists > 0, 
    'INSERT IGNORE INTO families (family_name, family_identifier, familyType, created_by, created_at)
     SELECT 
       CONCAT(SUBSTRING_INDEX(v.name, '' '', -1), '', '', SUBSTRING_INDEX(v.name, '' '', 1)) as family_name,
       CASE WHEN v.visitor_type = ''potential_regular'' THEN ''local_visitor'' ELSE ''traveller_visitor'' END as family_identifier,
       ''visitor'' as familyType,
       1 as created_by,
       v.created_at
     FROM visitors v
     LEFT JOIN individuals i ON (
       i.first_name = SUBSTRING_INDEX(v.name, '' '', 1) AND 
       i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, '' '', 1)) + 2) AND
       i.people_type IN (''local_visitor'', ''traveller_visitor'')
     )
     WHERE i.id IS NULL
     GROUP BY v.name, v.visitor_type',
    'SELECT ''Visitors table does not exist, skipping visitor migration'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 3: Create individuals for visitors from old system that don't exist in new system
SET @sql = IF(@visitors_exists > 0,
    'INSERT IGNORE INTO individuals (first_name, last_name, family_id, people_type, last_attendance_date, is_active, created_at)
     SELECT 
       SUBSTRING_INDEX(v.name, '' '', 1) as first_name,
       SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, '' '', 1)) + 2) as last_name,
       f.id as family_id,
       CASE WHEN v.visitor_type = ''potential_regular'' THEN ''local_visitor'' ELSE ''traveller_visitor'' END as people_type,
       v.last_attended as last_attendance_date,
       true as is_active,
       v.created_at
     FROM visitors v
     JOIN families f ON (
       f.family_name = CONCAT(SUBSTRING_INDEX(v.name, '' '', -1), '', '', SUBSTRING_INDEX(v.name, '' '', 1)) AND
       f.familyType = ''visitor''
     )
     LEFT JOIN individuals i ON (
       i.first_name = SUBSTRING_INDEX(v.name, '' '', 1) AND 
       i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, '' '', 1)) + 2) AND
       i.people_type IN (''local_visitor'', ''traveller_visitor'')
     )
     WHERE i.id IS NULL
     GROUP BY v.name, v.visitor_type, f.id, v.last_attended, v.created_at',
    'SELECT ''Visitors table does not exist, skipping individual migration'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 4: Add migrated individuals to gathering_lists for their appropriate gatherings
SET @sql = IF(@visitors_exists > 0,
    'INSERT IGNORE INTO gathering_lists (gathering_type_id, individual_id)
     SELECT DISTINCT
       as_table.gathering_type_id,
       i.id as individual_id
     FROM visitors v
     JOIN attendance_sessions as_table ON v.session_id = as_table.id
     JOIN individuals i ON (
       i.first_name = SUBSTRING_INDEX(v.name, '' '', 1) AND 
       i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, '' '', 1)) + 2) AND
       i.people_type IN (''local_visitor'', ''traveller_visitor'')
     )
     WHERE i.family_id IN (
       SELECT f.id FROM families f WHERE f.familyType = ''visitor''
     )',
    'SELECT ''Visitors table does not exist, skipping gathering list migration'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 5: Create attendance records for migrated visitors based on old visitor records
SET @sql = IF(@visitors_exists > 0,
    'INSERT IGNORE INTO attendance_records (session_id, individual_id, present)
     SELECT DISTINCT
       v.session_id,
       i.id as individual_id,
       true as present
     FROM visitors v
     JOIN individuals i ON (
       i.first_name = SUBSTRING_INDEX(v.name, '' '', 1) AND 
       i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, '' '', 1)) + 2) AND
       i.people_type IN (''local_visitor'', ''traveller_visitor'')
     )
     WHERE i.family_id IN (
       SELECT f.id FROM families f WHERE f.familyType = ''visitor''
     )',
    'SELECT ''Visitors table does not exist, skipping attendance records migration'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 6: Update last_attendance_date for migrated visitors to ensure it's accurate
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
)
WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
AND i.last_attendance_date IS NULL;

-- Step 7: Add indexes for performance (only if they don't exist)
SET @index_exists = (SELECT COUNT(*) FROM information_schema.statistics 
    WHERE table_schema = DATABASE() 
    AND table_name = 'individuals' 
    AND index_name = 'idx_individuals_last_attendance');

SET @sql = IF(@index_exists = 0, 
    'CREATE INDEX idx_individuals_last_attendance ON individuals(last_attendance_date)',
    'SELECT ''Index idx_individuals_last_attendance already exists'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists = (SELECT COUNT(*) FROM information_schema.statistics 
    WHERE table_schema = DATABASE() 
    AND table_name = 'individuals' 
    AND index_name = 'idx_individuals_people_type_last_attendance');

SET @sql = IF(@index_exists = 0,
    'CREATE INDEX idx_individuals_people_type_last_attendance ON individuals(people_type, last_attendance_date)',
    'SELECT ''Index idx_individuals_people_type_last_attendance already exists'' as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 8: Clean up duplicates (if any were created)
DELETE i1 FROM individuals i1 
INNER JOIN individuals i2 
WHERE i1.id > i2.id 
AND i1.first_name = i2.first_name 
AND i1.last_name = i2.last_name 
AND i1.people_type = i2.people_type 
AND i1.people_type IN ('local_visitor', 'traveller_visitor');

-- Verification queries for manual checking
-- SELECT COUNT(*) as total_visitor_individuals FROM individuals WHERE people_type IN ('local_visitor', 'traveller_visitor');
-- SELECT COUNT(*) as visitor_families FROM families WHERE familyType = 'visitor';
-- SELECT 'Migration completed successfully' as status;