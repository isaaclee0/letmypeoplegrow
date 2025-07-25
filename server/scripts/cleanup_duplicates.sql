-- Cleanup script to remove duplicate families and individuals
-- This script identifies and removes duplicates while preserving original records

-- Start transaction for safety
START TRANSACTION;

-- Create a temporary table to store the families to keep (original families with lower IDs)
CREATE TEMPORARY TABLE families_to_keep AS
SELECT 
    family_name,
    MIN(id) as keep_id,
    GROUP_CONCAT(id ORDER BY id) as all_ids
FROM families 
GROUP BY family_name 
HAVING COUNT(*) > 1;

-- Create a temporary table to store the families to delete (duplicate families with higher IDs)
CREATE TEMPORARY TABLE families_to_delete AS
SELECT 
    f.id as delete_id,
    f.family_name,
    ftk.keep_id
FROM families f
JOIN families_to_keep ftk ON f.family_name = ftk.family_name
WHERE f.id != ftk.keep_id;

-- Show what will be deleted (for verification)
SELECT 'FAMILIES TO DELETE:' as info;
SELECT 
    ftd.delete_id,
    ftd.family_name,
    ftd.keep_id as original_family_id,
    f.created_at
FROM families_to_delete ftd
JOIN families f ON ftd.delete_id = f.id
ORDER BY ftd.delete_id;

-- Show individuals that will be deleted
SELECT 'INDIVIDUALS TO DELETE:' as info;
SELECT 
    i.id as individual_id,
    i.first_name,
    i.last_name,
    i.family_id as duplicate_family_id,
    ftd.keep_id as original_family_id,
    i.created_at
FROM individuals i
JOIN families_to_delete ftd ON i.family_id = ftd.delete_id
ORDER BY i.family_id, i.id;

-- Count totals for verification
SELECT 'SUMMARY:' as info;
SELECT 
    'Families to delete:' as item,
    COUNT(*) as count
FROM families_to_delete
UNION ALL
SELECT 
    'Individuals to delete:' as item,
    COUNT(*) as count
FROM individuals i
JOIN families_to_delete ftd ON i.family_id = ftd.delete_id;

-- Uncomment the following lines to actually perform the deletion:
-- DELETE FROM individuals WHERE family_id IN (SELECT delete_id FROM families_to_delete);
-- DELETE FROM families WHERE id IN (SELECT delete_id FROM families_to_delete);

-- Clean up temporary tables
DROP TEMPORARY TABLE IF EXISTS families_to_keep;
DROP TEMPORARY TABLE IF EXISTS families_to_delete;

-- Show final results
SELECT 'AFTER CLEANUP - REMAINING FAMILIES:' as info;
SELECT id, family_name, created_at FROM families ORDER BY id;

SELECT 'AFTER CLEANUP - REMAINING INDIVIDUALS:' as info;
SELECT 
    i.id,
    i.first_name,
    i.last_name,
    i.family_id,
    f.family_name,
    i.created_at
FROM individuals i
LEFT JOIN families f ON i.family_id = f.id
ORDER BY i.family_id, i.id;

-- Commit the transaction (only if deletions were performed)
-- COMMIT;

-- To rollback instead: ROLLBACK; 