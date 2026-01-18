-- Migration 019: Add historical people_type tracking to attendance_records
-- Simple version for direct execution in phpMyAdmin
-- This allows historical attendance to show the person's type at the time of attendance,
-- even if their type has changed since then.

-- Add people_type_at_time column if it doesn't exist
ALTER TABLE attendance_records 
ADD COLUMN IF NOT EXISTS people_type_at_time ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT NULL;

-- Add index for faster queries if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_people_type_at_time ON attendance_records(people_type_at_time);

-- Note: Existing records will have NULL for people_type_at_time.
-- The application code will fall back to current people_type for backward compatibility.





