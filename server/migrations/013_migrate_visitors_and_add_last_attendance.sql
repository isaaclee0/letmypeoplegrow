-- Migration 013: Migrate old visitors to new system and add last_attendance_date
-- This migration will:
-- 1. Add last_attendance_date column to individuals table
-- 2. Migrate all visitors from the old visitors table to individuals/families
-- 3. Set last_attendance_date for all individuals based on their most recent attendance
-- 4. Clean up duplicates and inconsistencies

-- Step 1: Update last_attendance_date for all existing individuals based on attendance records
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
);

-- Step 3: Create families for visitors from old system that don't exist in new system
INSERT IGNORE INTO families (family_name, family_identifier, familyType, created_by, created_at)
SELECT 
  CONCAT(SUBSTRING_INDEX(v.name, ' ', -1), ', ', SUBSTRING_INDEX(v.name, ' ', 1)) as family_name,
  CASE WHEN v.visitor_type = 'potential_regular' THEN 'local_visitor' ELSE 'traveller_visitor' END as family_identifier,
  'visitor' as familyType,
  1 as created_by, -- Default to admin user
  v.created_at
FROM visitors v
LEFT JOIN individuals i ON (
  i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
  i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
  i.people_type IN ('local_visitor', 'traveller_visitor')
)
WHERE i.id IS NULL  -- Only create families for visitors that don't exist in new system
GROUP BY v.name, v.visitor_type;

-- Step 4: Create individuals for visitors from old system that don't exist in new system
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
WHERE i.id IS NULL  -- Only create individuals that don't exist in new system
GROUP BY v.name, v.visitor_type, f.id, v.last_attended, v.created_at;

-- Step 5: Add migrated individuals to gathering_lists for their appropriate gatherings
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

-- Step 6: Create attendance records for migrated visitors based on old visitor records
INSERT IGNORE INTO attendance_records (session_id, individual_id, present)
SELECT DISTINCT
  v.session_id,
  i.id as individual_id,
  true as present -- All old visitor records represent attendance
FROM visitors v
JOIN individuals i ON (
  i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) AND 
  i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2) AND
  i.people_type IN ('local_visitor', 'traveller_visitor')
)
WHERE i.family_id IN (
  SELECT f.id FROM families f WHERE f.familyType = 'visitor'
);

-- Step 7: Update last_attendance_date for migrated visitors to ensure it's accurate
UPDATE individuals i
SET last_attendance_date = (
  SELECT MAX(as_table.session_date)
  FROM attendance_records ar
  JOIN attendance_sessions as_table ON ar.session_id = as_table.id
  WHERE ar.individual_id = i.id AND ar.present = true
)
WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
AND i.last_attendance_date IS NULL;

-- Step 8: Add index for performance on last_attendance_date queries
CREATE INDEX idx_individuals_last_attendance ON individuals(last_attendance_date);
CREATE INDEX idx_individuals_people_type_last_attendance ON individuals(people_type, last_attendance_date);

-- Verification queries (commented out for production, can be run manually)
-- SELECT COUNT(*) as old_visitors FROM visitors;
-- SELECT COUNT(*) as new_visitor_individuals FROM individuals WHERE people_type IN ('local_visitor', 'traveller_visitor');
-- SELECT COUNT(*) as visitor_families FROM families WHERE familyType = 'visitor';