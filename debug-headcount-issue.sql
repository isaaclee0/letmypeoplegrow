-- Debug script for headcount gathering ID 7 on 2025-09-05

-- Check if gathering ID 7 exists and its type
SELECT id, name, attendance_type, church_id FROM gathering_types WHERE id = 7;

-- Check if there are any attendance sessions for this gathering and date
SELECT id, gathering_type_id, session_date, created_by, church_id 
FROM attendance_sessions 
WHERE gathering_type_id = 7 AND session_date = '2025-09-05';

-- Check if there are any headcount records for this session
SELECT h.id, h.session_id, h.headcount, h.updated_by, h.church_id, u.first_name, u.last_name
FROM headcount_records h
LEFT JOIN users u ON h.updated_by = u.id
WHERE h.session_id IN (
  SELECT id FROM attendance_sessions 
  WHERE gathering_type_id = 7 AND session_date = '2025-09-05'
);

-- Check what church_id the current user belongs to (you'll need to replace with actual user ID)
-- SELECT church_id FROM users WHERE id = [YOUR_USER_ID];

-- Check if there are any foreign key constraint issues
SELECT 
  TABLE_NAME,
  COLUMN_NAME,
  CONSTRAINT_NAME,
  REFERENCED_TABLE_NAME,
  REFERENCED_COLUMN_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
WHERE TABLE_NAME = 'headcount_records' 
  AND REFERENCED_TABLE_NAME IS NOT NULL;
