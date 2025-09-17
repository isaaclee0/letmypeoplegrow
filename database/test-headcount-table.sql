-- Test script to check if headcount_records table exists and is accessible

-- Check if table exists
SHOW TABLES LIKE 'headcount_records';

-- Check table structure
DESCRIBE headcount_records;

-- Check if we can query the table (should return empty result, not error)
SELECT COUNT(*) as record_count FROM headcount_records;

-- Check if gathering_types has the attendance_type column
DESCRIBE gathering_types;

-- Check if any gatherings are set to headcount type
SELECT id, name, attendance_type FROM gathering_types WHERE attendance_type = 'headcount';
