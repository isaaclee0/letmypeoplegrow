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

-- Step 1: Handle the unique constraint change on headcount_records (MariaDB compatible)
-- The current unique constraint on session_id prevents multiple users from having separate headcounts
-- We need to change it to allow multiple records per session (one per user)

-- Check current state
SET @has_old_constraint = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'headcount_records' 
  AND INDEX_NAME = 'unique_session_headcount');

SET @has_new_constraint = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'headcount_records' 
  AND INDEX_NAME = 'unique_session_user');

-- Add the new unique constraint if it doesn't exist
SET @sql = (SELECT IF(
  @has_new_constraint = 0,
  'ALTER TABLE headcount_records ADD UNIQUE KEY unique_session_user (session_id, updated_by)',
  'SELECT "New unique constraint already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- For MariaDB, we'll use a more direct approach to handle the old constraint
-- MariaDB allows us to use IGNORE to suppress errors
SET @sql = (SELECT IF(
  @has_old_constraint > 0,
  'ALTER IGNORE TABLE headcount_records DROP INDEX unique_session_headcount',
  'SELECT "Old unique constraint does not exist" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 3: Add a mode column to attendance_sessions to track the headcount mode for each session
-- Check if the column already exists before adding it
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
   AND TABLE_NAME = 'attendance_sessions' 
   AND COLUMN_NAME = 'headcount_mode') > 0,
  'SELECT "Column headcount_mode already exists" as message',
  'ALTER TABLE attendance_sessions ADD COLUMN headcount_mode ENUM(\'separate\', \'combined\', \'averaged\') DEFAULT \'separate\' AFTER notes'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 4: Add an index for the new mode column
-- Check if the index already exists before adding it
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
   WHERE TABLE_SCHEMA = DATABASE() 
   AND TABLE_NAME = 'attendance_sessions' 
   AND INDEX_NAME = 'idx_headcount_mode') > 0,
  'SELECT "Index idx_headcount_mode already exists" as message',
  'ALTER TABLE attendance_sessions ADD INDEX idx_headcount_mode (headcount_mode)'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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
