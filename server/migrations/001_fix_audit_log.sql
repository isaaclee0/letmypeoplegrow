-- Migration 001: Fix audit_log table structure
-- Add missing entity_type and entity_id columns

-- Check if entity_type column exists, if not add it
SET @entity_type_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                          WHERE TABLE_SCHEMA = DATABASE() 
                          AND TABLE_NAME = 'audit_log' 
                          AND COLUMN_NAME = 'entity_type');

SET @sql = IF(@entity_type_exists = 0, 
              'ALTER TABLE audit_log ADD COLUMN entity_type VARCHAR(50) AFTER action',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check if entity_id column exists, if not add it
SET @entity_id_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                        WHERE TABLE_SCHEMA = DATABASE() 
                        AND TABLE_NAME = 'audit_log' 
                        AND COLUMN_NAME = 'entity_id');

SET @sql = IF(@entity_id_exists = 0, 
              'ALTER TABLE audit_log ADD COLUMN entity_id INT AFTER entity_type',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for the new columns if it doesn't exist
SET @index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                    AND TABLE_NAME = 'audit_log' 
                    AND INDEX_NAME = 'idx_entity');

SET @sql = IF(@index_exists = 0, 
              'ALTER TABLE audit_log ADD INDEX idx_entity (entity_type, entity_id)',
              'SELECT 1 as dummy');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt; 