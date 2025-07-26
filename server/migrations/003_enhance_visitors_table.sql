-- Migration 003: Enhance visitors table for better attendance tracking
-- Add session_id and improve visitor management

-- Check if session_id column exists, if not add it
SET @session_id_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                         WHERE TABLE_SCHEMA = DATABASE() 
                         AND TABLE_NAME = 'visitors' 
                         AND COLUMN_NAME = 'session_id');

SET @sql = IF(@session_id_exists = 0, 
              'ALTER TABLE visitors ADD COLUMN session_id INT AFTER id',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add foreign key for session_id if it doesn't exist
SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
                  WHERE TABLE_SCHEMA = DATABASE() 
                  AND TABLE_NAME = 'visitors' 
                  AND COLUMN_NAME = 'session_id' 
                  AND REFERENCED_TABLE_NAME = 'attendance_sessions');

SET @sql = IF(@fk_exists = 0, 
              'ALTER TABLE visitors ADD CONSTRAINT fk_visitors_session FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for session_id if it doesn't exist
SET @session_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                            WHERE TABLE_SCHEMA = DATABASE() 
                            AND TABLE_NAME = 'visitors' 
                            AND INDEX_NAME = 'idx_session');

SET @sql = IF(@session_index_exists = 0, 
              'ALTER TABLE visitors ADD INDEX idx_session (session_id)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add last_attended column to track when visitor last attended
SET @last_attended_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                            WHERE TABLE_SCHEMA = DATABASE() 
                            AND TABLE_NAME = 'visitors' 
                            AND COLUMN_NAME = 'last_attended');

SET @sql = IF(@last_attended_exists = 0, 
              'ALTER TABLE visitors ADD COLUMN last_attended DATE AFTER notes',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for last_attended if it doesn't exist
SET @last_attended_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                                  WHERE TABLE_SCHEMA = DATABASE() 
                                  AND TABLE_NAME = 'visitors' 
                                  AND INDEX_NAME = 'idx_last_attended');

SET @sql = IF(@last_attended_index_exists = 0, 
              'ALTER TABLE visitors ADD INDEX idx_last_attended (last_attended)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt; 