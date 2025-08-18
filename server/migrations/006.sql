-- Migration 006: Fix attendance sessions unique constraint to include church_id
-- This fixes the issue where changing attendance for one gathering type
-- would affect all churches using the same gathering type and date

-- First, drop the existing unique constraint
ALTER TABLE attendance_sessions DROP INDEX unique_session;

-- Add a new unique constraint that includes church_id
ALTER TABLE attendance_sessions ADD UNIQUE KEY unique_session_with_church (gathering_type_id, session_date, church_id);

-- Add comment to document the change
ALTER TABLE attendance_sessions COMMENT = 'Updated unique constraint to include church_id for proper isolation';
