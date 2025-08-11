-- Migration 021: Simplify church_id system and consolidate data
-- This migration consolidates all scattered church_ids into a simple system

-- Step 1: Create a simple church_id for the existing church
UPDATE church_settings 
SET church_id = 'devch1' 
WHERE church_name = 'Development Church';

-- Step 2: Update all users to use the same church_id
UPDATE users 
SET church_id = 'devch1' 
WHERE email IN ('dev@church.local', 'admin@church.local', 'coord@church.local', 'at@church.local');

-- Step 3: Update all individuals to use the same church_id
UPDATE individuals 
SET church_id = 'devch1';

-- Step 4: Update all families to use the same church_id
UPDATE families 
SET church_id = 'devch1';

-- Step 5: Update all gathering_types to use the same church_id
UPDATE gathering_types 
SET church_id = 'devch1';

-- Step 6: Update all attendance_sessions to use the same church_id
UPDATE attendance_sessions 
SET church_id = 'devch1';

-- Step 7: Update all attendance_records to use the same church_id
UPDATE attendance_records 
SET church_id = 'devch1';

-- Step 8: Update all notifications to use the same church_id
UPDATE notifications 
SET church_id = 'devch1';

-- Step 9: Update all notification_rules to use the same church_id
UPDATE notification_rules 
SET church_id = 'devch1';

-- Step 10: Update all onboarding_progress to use the same church_id
UPDATE onboarding_progress 
SET church_id = 'devch1';

-- Step 11: Update all otc_codes to use the same church_id
UPDATE otc_codes 
SET church_id = 'devch1';

-- Step 12: Update all user_gathering_assignments to use the same church_id
UPDATE user_gathering_assignments 
SET church_id = 'devch1';

-- Step 13: Update all user_invitations to use the same church_id
UPDATE user_invitations 
SET church_id = 'devch1';

-- Step 14: Update all audit_log to use the same church_id
UPDATE audit_log 
SET church_id = 'devch1';

-- Step 15: Update all api_keys to use the same church_id
UPDATE api_keys 
SET church_id = 'devch1';

-- Step 16: Update all api_access_logs to use the same church_id
UPDATE api_access_logs 
SET church_id = 'devch1';

-- Step 17: Add a function to generate simple church_ids
DELIMITER //
CREATE FUNCTION generate_simple_church_id(church_name VARCHAR(255)) 
RETURNS VARCHAR(50)
READS SQL DATA
DETERMINISTIC
BEGIN
    DECLARE base_id VARCHAR(50);
    DECLARE counter INT DEFAULT 1;
    DECLARE final_id VARCHAR(50);
    
    -- Convert church name to simple format (lowercase, no spaces, no special chars)
    SET base_id = LOWER(REGEXP_REPLACE(church_name, '[^a-zA-Z0-9]', ''));
    
    -- Limit to 20 characters
    SET base_id = LEFT(base_id, 20);
    
    -- Check if this base_id already exists
    WHILE EXISTS (SELECT 1 FROM church_settings WHERE church_id = CONCAT(base_id, counter)) DO
        SET counter = counter + 1;
    END WHILE;
    
    SET final_id = CONCAT(base_id, counter);
    RETURN final_id;
END //
DELIMITER ;
