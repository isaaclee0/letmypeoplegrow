-- Migration 004: Add visitor flag to individuals table
-- This helps identify people who were originally added as visitors

-- Check if is_visitor column exists, if not add it
SET @is_visitor_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                         WHERE TABLE_SCHEMA = DATABASE() 
                         AND TABLE_NAME = 'individuals' 
                         AND COLUMN_NAME = 'is_visitor');

SET @sql = IF(@is_visitor_exists = 0, 
              'ALTER TABLE individuals ADD COLUMN is_visitor BOOLEAN DEFAULT false AFTER is_active',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for is_visitor if it doesn't exist
SET @visitor_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                            WHERE TABLE_SCHEMA = DATABASE() 
                            AND TABLE_NAME = 'individuals' 
                            AND INDEX_NAME = 'idx_is_visitor');

SET @sql = IF(@visitor_index_exists = 0, 
              'ALTER TABLE individuals ADD INDEX idx_is_visitor (is_visitor)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt; 