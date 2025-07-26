-- Fix audit_log table structure
-- Add missing columns if they don't exist

-- Check if entity_type column exists, if not add it
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'audit_log' 
     AND COLUMN_NAME = 'entity_type') = 0,
    'ALTER TABLE audit_log ADD COLUMN entity_type VARCHAR(50) AFTER action',
    'SELECT "entity_type column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check if entity_id column exists, if not add it
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'audit_log' 
     AND COLUMN_NAME = 'entity_id') = 0,
    'ALTER TABLE audit_log ADD COLUMN entity_id INT AFTER entity_type',
    'SELECT "entity_id column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for the new columns if they don't exist
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'audit_log' 
     AND INDEX_NAME = 'idx_entity') = 0,
    'ALTER TABLE audit_log ADD INDEX idx_entity (entity_type, entity_id)',
    'SELECT "idx_entity index already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Show the final table structure
DESCRIBE audit_log; 