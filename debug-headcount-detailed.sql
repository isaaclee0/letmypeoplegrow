-- Detailed debug for headcount gathering ID 7 on 2025-09-05

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

-- Check if user ID 2 has access to gathering ID 7
SELECT uga.id, uga.user_id, uga.gathering_type_id, uga.church_id
FROM user_gathering_assignments uga
WHERE uga.user_id = 2 AND uga.gathering_type_id = 7;

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

-- Test the exact query that's failing
SELECT h.headcount, h.updated_at, u.first_name, u.last_name
FROM headcount_records h
LEFT JOIN users u ON h.updated_by = u.id
WHERE h.session_id = 999; -- This should return empty result, not error
