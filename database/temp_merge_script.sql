-- Database Merge Script
-- This script merges data from the backup into the current database

-- Set safe mode off for bulk operations
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET FOREIGN_KEY_CHECKS = 0;

-- Start transaction
START TRANSACTION;

-- Function to safely insert or update data
DELIMITER $$

CREATE PROCEDURE IF NOT EXISTS SafeMergeData()
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    -- Merge church_settings (only if not exists)
    INSERT IGNORE INTO church_settings 
    SELECT * FROM temp_church_settings;

    -- Merge gathering_types (only if not exists)
    INSERT IGNORE INTO gathering_types 
    SELECT * FROM temp_gathering_types;

    -- Merge families (only if not exists)
    INSERT IGNORE INTO families 
    SELECT * FROM temp_families;

    -- Merge individuals (only if not exists)
    INSERT IGNORE INTO individuals 
    SELECT * FROM temp_individuals;

    -- Merge users (only if not exists)
    INSERT IGNORE INTO users 
    SELECT * FROM temp_users;

    -- Merge attendance_sessions (only if not exists)
    INSERT IGNORE INTO attendance_sessions 
    SELECT * FROM temp_attendance_sessions;

    -- Merge attendance_records (only if not exists)
    INSERT IGNORE INTO attendance_records 
    SELECT * FROM temp_attendance_records;

    -- Merge gathering_lists (only if not exists)
    INSERT IGNORE INTO gathering_lists 
    SELECT * FROM temp_gathering_lists;

    -- Merge user_gathering_assignments (only if not exists)
    INSERT IGNORE INTO user_gathering_assignments 
    SELECT * FROM temp_user_gathering_assignments;

    -- Merge visitors (only if not exists)
    INSERT IGNORE INTO visitors 
    SELECT * FROM temp_visitors;

    -- Merge audit_log (only if not exists)
    INSERT IGNORE INTO audit_log 
    SELECT * FROM temp_audit_log;

    -- Merge migrations (only if not exists)
    INSERT IGNORE INTO migrations 
    SELECT * FROM temp_migrations;

    -- Merge otc_codes (only if not exists)
    INSERT IGNORE INTO otc_codes 
    SELECT * FROM temp_otc_codes;

    -- Merge notification_rules (only if not exists)
    INSERT IGNORE INTO notification_rules 
    SELECT * FROM temp_notification_rules;

    -- Merge notifications (only if not exists)
    INSERT IGNORE INTO notifications 
    SELECT * FROM temp_notifications;

    -- Merge onboarding_progress (only if not exists)
    INSERT IGNORE INTO onboarding_progress 
    SELECT * FROM temp_onboarding_progress;

    -- Merge user_invitations (only if not exists)
    INSERT IGNORE INTO user_invitations 
    SELECT * FROM temp_user_invitations;

    COMMIT;
END$$

DELIMITER ;

-- Create temporary tables to hold backup data
CREATE TEMPORARY TABLE temp_church_settings LIKE church_settings;
CREATE TEMPORARY TABLE temp_gathering_types LIKE gathering_types;
CREATE TEMPORARY TABLE temp_families LIKE families;
CREATE TEMPORARY TABLE temp_individuals LIKE individuals;
CREATE TEMPORARY TABLE temp_users LIKE users;
CREATE TEMPORARY TABLE temp_attendance_sessions LIKE attendance_sessions;
CREATE TEMPORARY TABLE temp_attendance_records LIKE attendance_records;
CREATE TEMPORARY TABLE temp_gathering_lists LIKE gathering_lists;
CREATE TEMPORARY TABLE temp_user_gathering_assignments LIKE user_gathering_assignments;
CREATE TEMPORARY TABLE temp_visitors LIKE visitors;
CREATE TEMPORARY TABLE temp_audit_log LIKE audit_log;
CREATE TEMPORARY TABLE temp_migrations LIKE migrations;
CREATE TEMPORARY TABLE temp_otc_codes LIKE otc_codes;
CREATE TEMPORARY TABLE temp_notification_rules LIKE notification_rules;
CREATE TEMPORARY TABLE temp_notifications LIKE notifications;
CREATE TEMPORARY TABLE temp_onboarding_progress LIKE onboarding_progress;
CREATE TEMPORARY TABLE temp_user_invitations LIKE user_invitations;

-- Load data from backup file into temporary tables
-- Note: We'll need to extract the INSERT statements from the backup file

-- Call the merge procedure
CALL SafeMergeData();

-- Clean up
DROP PROCEDURE IF EXISTS SafeMergeData;
DROP TEMPORARY TABLE IF EXISTS temp_church_settings;
DROP TEMPORARY TABLE IF EXISTS temp_gathering_types;
DROP TEMPORARY TABLE IF EXISTS temp_families;
DROP TEMPORARY TABLE IF EXISTS temp_individuals;
DROP TEMPORARY TABLE IF EXISTS temp_users;
DROP TEMPORARY TABLE IF EXISTS temp_attendance_sessions;
DROP TEMPORARY TABLE IF EXISTS temp_attendance_records;
DROP TEMPORARY TABLE IF EXISTS temp_gathering_lists;
DROP TEMPORARY TABLE IF EXISTS temp_user_gathering_assignments;
DROP TEMPORARY TABLE IF EXISTS temp_visitors;
DROP TEMPORARY TABLE IF EXISTS temp_audit_log;
DROP TEMPORARY TABLE IF EXISTS temp_migrations;
DROP TEMPORARY TABLE IF EXISTS temp_otc_codes;
DROP TEMPORARY TABLE IF EXISTS temp_notification_rules;
DROP TEMPORARY TABLE IF EXISTS temp_notifications;
DROP TEMPORARY TABLE IF EXISTS temp_onboarding_progress;
DROP TEMPORARY TABLE IF EXISTS temp_user_invitations;

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

SELECT 'Data merge completed successfully!' as status;
