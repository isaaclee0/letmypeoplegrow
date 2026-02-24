-- Diagnostic script for office@crcsouthtas.org not seeing regular attendance records
-- Run against your local dev DB: mariadb -u church_user -pchurch_password church_attendance < scripts/diagnose-attendance-visibility.sql

-- 1. User and church context
SELECT '=== USER & CHURCH ===' as section;
SELECT u.id as user_id, u.email, u.role, u.church_id as user_church_id
FROM users u
WHERE u.email = 'office@crcsouthtas.org';

-- 2. User's gathering assignments (coordinator/attendance_taker need these to see any attendance)
SELECT '=== GATHERING ASSIGNMENTS ===' as section;
SELECT uga.gathering_type_id, gt.name as gathering_name, gt.church_id as gathering_church_id
FROM user_gathering_assignments uga
JOIN gathering_types gt ON uga.gathering_type_id = gt.id
JOIN users u ON uga.user_id = u.id
WHERE u.email = 'office@crcsouthtas.org';

-- 3. Does gathering_lists have church_id? (Schema check)
SELECT '=== GATHERING_LISTS SCHEMA ===' as section;
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gathering_lists' AND COLUMN_NAME = 'church_id';

-- 4. Sample: gathering_lists rows for this church's first gathering
SELECT '=== GATHERING_LISTS (sample) ===' as section;
SELECT gl.id, gl.gathering_type_id, gl.individual_id, gl.church_id as gl_church_id
FROM gathering_lists gl
JOIN users u ON u.email = 'office@crcsouthtas.org'
WHERE gl.gathering_type_id IN (
  SELECT uga.gathering_type_id FROM user_gathering_assignments uga
  JOIN users u2 ON uga.user_id = u2.id WHERE u2.email = 'office@crcsouthtas.org' LIMIT 1
)
LIMIT 10;

-- 5. Individuals on gathering list - check family_type and people_type (regular filter)
SELECT '=== INDIVIDUALS ON GATHERING LIST (family/people type) ===' as section;
SELECT i.id, i.first_name, i.last_name, i.people_type, i.is_active, i.church_id,
       f.family_type, f.id as family_id
FROM gathering_lists gl
JOIN individuals i ON gl.individual_id = i.id
LEFT JOIN families f ON i.family_id = f.id
JOIN users u ON u.email = 'office@crcsouthtas.org'
WHERE gl.gathering_type_id IN (
  SELECT uga.gathering_type_id FROM user_gathering_assignments uga
  JOIN users u2 ON uga.user_id = u2.id WHERE u2.email = 'office@crcsouthtas.org' LIMIT 1
)
AND i.church_id = u.church_id
LIMIT 20;

-- 6. Attendance records count (if church_id exists on attendance_records)
SELECT '=== ATTENDANCE RECORDS ===' as section;
SELECT COUNT(*) as total_attendance_records
FROM attendance_records ar
WHERE EXISTS (SELECT 1 FROM users u WHERE u.email = 'office@crcsouthtas.org');

-- 7. Church IDs: are they consistent?
SELECT '=== CHURCH ID CONSISTENCY ===' as section;
SELECT 
  (SELECT church_id FROM users WHERE email = 'office@crcsouthtas.org' LIMIT 1) as user_church_id,
  (SELECT church_id FROM individuals LIMIT 1) as sample_individual_church_id,
  (SELECT church_id FROM gathering_lists LIMIT 1) as sample_gl_church_id,
  (SELECT church_id FROM gathering_types WHERE church_id IS NOT NULL LIMIT 1) as sample_gt_church_id;
