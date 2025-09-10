-- Migration script from version 1.1.1 to 1.1.3
-- This script can be run directly in phpMyAdmin on the live database
-- 
-- Changes included:
-- 1. User Preferences Table - For storing user UI preferences and last viewed data
-- 2. Headcount Modes Support - Allow multiple headcount records per session

-- =====================================================
-- 1. USER PREFERENCES TABLE
-- =====================================================

-- Create user_preferences table for storing user UI preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  preference_key VARCHAR(100) NOT NULL,
  preference_value JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_preference (user_id, preference_key),
  INDEX idx_user_id (user_id),
  INDEX idx_church_id (church_id),
  INDEX idx_preference_key (preference_key)
) ENGINE=InnoDB;

-- =====================================================
-- 2. HEADCOUNT MODES SUPPORT
-- =====================================================

-- Step 1: Drop the existing unique constraint on headcount_records
-- This allows multiple users to have separate headcounts for the same session
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

-- =====================================================
-- 3. UPDATE MIGRATIONS TABLE
-- =====================================================

-- Record these migrations in the migrations table
INSERT INTO migrations (version, name, description, executed_at, status) VALUES
('016_user_preferences_table', '016_user_preferences_table.sql', 'Add user preferences table for storing UI preferences and last viewed data', NOW(), 'success'),
('017_headcount_modes_support', '017_headcount_modes_support.sql', 'Add headcount modes support - allow multiple headcount records per session', NOW(), 'success');

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================

-- The following features are now available:
-- 
-- USER PREFERENCES:
-- - 'attendance_last_viewed' - {gatheringId: number, date: string, timestamp: number}
-- - 'reports_last_viewed' - {selectedGatherings: number[], startDate: string, endDate: string, timestamp: number}
-- - 'people_last_viewed' - {selectedGathering: number, searchTerm: string, timestamp: number}
-- - 'attendance_gathering_dates' - {gatheringId: number, lastViewedDate: string, timestamp: number}
--
-- HEADCOUNT MODES:
-- - 'separate' mode: Each user can have their own headcount for the same session (default)
-- - 'combined' mode: All headcounts are summed together
-- - 'averaged' mode: All headcounts are averaged together
--
-- The frontend will handle these different modes appropriately.
