-- Migration 019: Add historical people_type tracking to attendance_records
-- This allows historical attendance to show the person's type at the time of attendance,
-- even if their type has changed since then.

-- Add people_type_at_time column to store historical people_type
ALTER TABLE attendance_records
ADD COLUMN people_type_at_time ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT NULL;

-- Add index for faster queries
CREATE INDEX idx_people_type_at_time ON attendance_records(people_type_at_time);

-- Note: Existing records will have NULL for people_type_at_time.
-- The application code will fall back to current people_type for backward compatibility.

