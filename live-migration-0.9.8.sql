-- Live Migration Script for v0.9.8
-- Service-based visitor filtering and database constraints
-- Target: wpclick@192.168.193.11 production database
-- Date: 2025-08-18

-- Check current database before migration
SELECT 'Starting migration v0.9.8' as status;

-- 1. Fix attendance_sessions unique constraint to include church_id
-- This ensures attendance sessions are unique per gathering type, date, AND church

-- Check if old unique constraint exists and drop it
SELECT 'Checking attendance_sessions constraints...' as status;

-- Drop old unique constraint if it exists (safe operation)
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
     WHERE table_name = 'attendance_sessions' 
     AND index_name = 'unique_session' 
     AND table_schema = DATABASE()) > 0,
    'ALTER TABLE attendance_sessions DROP INDEX unique_session',
    'SELECT "No old unique_session constraint found" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add new unique constraint including church_id
ALTER TABLE attendance_sessions
ADD CONSTRAINT unique_session_with_church UNIQUE (gathering_type_id, session_date, church_id);

SELECT 'Added unique constraint with church_id to attendance_sessions' as status;

-- 2. Create visitor_config table for configurable visitor filtering
CREATE TABLE IF NOT EXISTS visitor_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(36) NOT NULL,
  local_visitor_service_limit INT NOT NULL DEFAULT 6,
  traveller_visitor_service_limit INT NOT NULL DEFAULT 2,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_church_config (church_id),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

SELECT 'Created visitor_config table' as status;

-- 3. Insert default configurations for existing churches
INSERT IGNORE INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
SELECT DISTINCT church_id, 6, 2 
FROM users 
WHERE church_id IS NOT NULL;

SELECT 'Inserted default visitor configurations for existing churches' as status;

-- 4. Update migrations table to record these changes
INSERT IGNORE INTO migrations (version, name, description, status, executed_at)
VALUES 
('006', 'fix_attendance_sessions_unique_constraint', 'Fix attendance sessions unique constraint to include church_id', 'success', NOW()),
('007', 'add_visitor_config', 'Add visitor filtering configuration table', 'success', NOW());

SELECT 'Updated migrations table' as status;

-- 5. Verify the migration
SELECT 'Verifying migration...' as status;

-- Check attendance_sessions constraint
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'SUCCESS: unique_session_with_church constraint exists'
    ELSE 'ERROR: unique_session_with_church constraint missing'
  END as attendance_sessions_check
FROM INFORMATION_SCHEMA.STATISTICS 
WHERE table_name = 'attendance_sessions' 
AND index_name = 'unique_session_with_church' 
AND table_schema = DATABASE();

-- Check visitor_config table
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'SUCCESS: visitor_config table exists'
    ELSE 'ERROR: visitor_config table missing'
  END as visitor_config_check
FROM INFORMATION_SCHEMA.TABLES 
WHERE table_name = 'visitor_config' 
AND table_schema = DATABASE();

-- Check visitor config data
SELECT 
  CONCAT('SUCCESS: ', COUNT(*), ' church configurations created') as config_data_check
FROM visitor_config;

-- Show final migration status
SELECT 'Migration v0.9.8 completed successfully!' as final_status;

-- Display current church configurations
SELECT 'Current visitor configurations:' as status;
SELECT 
  church_id,
  local_visitor_service_limit,
  traveller_visitor_service_limit,
  created_at
FROM visitor_config
ORDER BY church_id;
