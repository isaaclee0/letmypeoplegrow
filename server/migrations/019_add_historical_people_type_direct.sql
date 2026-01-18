-- Migration 019: Add historical people_type tracking to attendance_records
-- Direct SQL version for phpMyAdmin
-- Run this SQL directly in phpMyAdmin

-- Step 1: Check if column exists, then add it
-- If the column already exists, you'll get an error - that's okay, just skip to Step 2

ALTER TABLE attendance_records 
ADD COLUMN people_type_at_time ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT NULL;

-- Step 2: Add index (if it already exists, you'll get an error - that's okay)

CREATE INDEX idx_people_type_at_time ON attendance_records(people_type_at_time);

-- Note: If you get "Duplicate column name" or "Duplicate key name" errors, 
-- that means the migration has already been applied and you can ignore the errors.





