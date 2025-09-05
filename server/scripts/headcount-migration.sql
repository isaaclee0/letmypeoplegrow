-- Migration script for headcount-only gatherings feature
-- This script adds support for headcount-only gatherings with custom scheduling

-- Add new columns to gathering_types table
ALTER TABLE gathering_types 
ADD COLUMN attendance_type ENUM('standard', 'headcount') DEFAULT 'standard' AFTER frequency,
ADD COLUMN custom_schedule JSON DEFAULT NULL AFTER attendance_type,
ADD INDEX idx_attendance_type (attendance_type);

-- Create headcount_records table for tracking headcount-only attendance
CREATE TABLE IF NOT EXISTS headcount_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  headcount INT NOT NULL DEFAULT 0,
  updated_by INT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session_headcount (session_id),
  INDEX idx_church_id (church_id),
  INDEX idx_updated_by (updated_by)
) ENGINE=InnoDB;

-- Add church_id to gathering_types if it doesn't exist (for multi-tenant support)
-- This is a safe operation that won't fail if the column already exists
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
   AND TABLE_NAME = 'gathering_types' 
   AND COLUMN_NAME = 'church_id') > 0,
  'SELECT "church_id column already exists" as message',
  'ALTER TABLE gathering_types ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT "default" AFTER created_by, ADD INDEX idx_church_id (church_id)'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Update existing gatherings to have standard attendance type
UPDATE gathering_types SET attendance_type = 'standard' WHERE attendance_type IS NULL;
