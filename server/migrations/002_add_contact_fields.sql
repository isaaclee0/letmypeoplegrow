-- Migration 002: Add contact fields to individuals table
-- Add phone and email columns for better contact management

-- Check if phone column exists, if not add it
SET @phone_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                    AND TABLE_NAME = 'individuals' 
                    AND COLUMN_NAME = 'phone');

SET @sql = IF(@phone_exists = 0, 
              'ALTER TABLE individuals ADD COLUMN phone VARCHAR(20) AFTER last_name',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check if email column exists, if not add it
SET @email_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                    AND TABLE_NAME = 'individuals' 
                    AND COLUMN_NAME = 'email');

SET @sql = IF(@email_exists = 0, 
              'ALTER TABLE individuals ADD COLUMN email VARCHAR(255) AFTER phone',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add indexes for the new columns
SET @phone_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                          WHERE TABLE_SCHEMA = DATABASE() 
                          AND TABLE_NAME = 'individuals' 
                          AND INDEX_NAME = 'idx_phone');

SET @sql = IF(@phone_index_exists = 0, 
              'ALTER TABLE individuals ADD INDEX idx_phone (phone)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @email_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                          WHERE TABLE_SCHEMA = DATABASE() 
                          AND TABLE_NAME = 'individuals' 
                          AND INDEX_NAME = 'idx_email');

SET @sql = IF(@email_index_exists = 0, 
              'ALTER TABLE individuals ADD INDEX idx_email (email)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt; 