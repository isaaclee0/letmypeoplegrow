-- Migration script for headcount modes feature
-- This script adds support for separate, combined, and averaged headcount modes

-- First, we need to modify the headcount_records table to support per-user records
-- The current table has a UNIQUE constraint on session_id, which prevents multiple users
-- from having separate headcounts for the same session

-- Step 1: Drop the existing unique constraint
ALTER TABLE headcount_records DROP INDEX unique_session_headcount;

-- Step 2: Add a new unique constraint that allows multiple records per session (one per user)
ALTER TABLE headcount_records ADD UNIQUE KEY unique_session_user (session_id, updated_by);

-- Step 3: Add a mode column to attendance_sessions to track the headcount mode for each session
ALTER TABLE attendance_sessions 
ADD COLUMN headcount_mode ENUM('separate', 'combined', 'averaged') DEFAULT 'separate' AFTER notes;

-- Step 4: Add an index for the new mode column
ALTER TABLE attendance_sessions ADD INDEX idx_headcount_mode (headcount_mode);

-- Step 5: Update existing sessions to use 'separate' mode (which is the new default)
UPDATE attendance_sessions SET headcount_mode = 'separate' WHERE headcount_mode IS NULL;

-- Note: The existing data will be preserved, but the behavior will change:
-- - In 'separate' mode: Each user can have their own headcount for the same session
-- - In 'combined' mode: All headcounts are summed together
-- - In 'averaged' mode: All headcounts are averaged together
-- 
-- The frontend will need to be updated to handle these different modes appropriately.
