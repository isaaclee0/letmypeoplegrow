-- Migration 016: Align familyType and people_type ENUMs
-- Make both tables use the same type distinctions: 'regular', 'local_visitor', 'traveller_visitor'

USE church_attendance;

-- ============================================================================
-- PART 1: UPDATE FAMILIES TABLE familyType ENUM
-- ============================================================================

-- First, let's see what we have currently
-- Current familyType: ENUM('regular', 'visitor')
-- Target familyType: ENUM('regular', 'local_visitor', 'traveller_visitor')

-- Step 1: Add a temporary column to store the new enum values
ALTER TABLE families ADD COLUMN familyType_new ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular';

-- Step 2: Migrate existing data based on family_identifier patterns and individual people_type
-- Families with visitor individuals should get their type from the individuals
UPDATE families f
SET familyType_new = (
    SELECT CASE 
        WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = 'local_visitor' THEN 'local_visitor'
        WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = 'traveller_visitor' THEN 'traveller_visitor'
        WHEN COUNT(DISTINCT i.people_type) > 1 AND SUM(CASE WHEN i.people_type IN ('local_visitor', 'traveller_visitor') THEN 1 ELSE 0 END) > 0 THEN 
            -- Mixed family - choose the visitor type that appears most frequently
            CASE WHEN SUM(CASE WHEN i.people_type = 'local_visitor' THEN 1 ELSE 0 END) >= SUM(CASE WHEN i.people_type = 'traveller_visitor' THEN 1 ELSE 0 END)
                 THEN 'local_visitor' 
                 ELSE 'traveller_visitor' 
            END
        ELSE 'regular'
    END
    FROM individuals i 
    WHERE i.family_id = f.id
)
WHERE f.familyType = 'visitor';

-- Step 3: Handle families with no individuals (should remain regular)
UPDATE families f
SET familyType_new = 'regular'
WHERE f.familyType = 'regular' OR familyType_new IS NULL;

-- Step 4: Handle edge case - visitor families with family_identifier hints
UPDATE families f
SET familyType_new = CASE 
    WHEN f.family_identifier LIKE '%local_visitor%' THEN 'local_visitor'
    WHEN f.family_identifier LIKE '%traveller_visitor%' THEN 'traveller_visitor'
    ELSE familyType_new
END
WHERE f.familyType = 'visitor' AND f.family_identifier IS NOT NULL;

-- Step 5: Drop the old column and rename the new one
ALTER TABLE families DROP COLUMN familyType;
ALTER TABLE families CHANGE COLUMN familyType_new familyType ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular';

-- Step 6: Add index for the new familyType column
CREATE INDEX idx_family_type_new ON families (familyType);

-- ============================================================================
-- PART 2: VERIFY DATA CONSISTENCY
-- ============================================================================

-- Ensure family types match their members' people_type where possible
-- This is a consistency check - families should generally have the same type as their members

-- Update families to match unanimous member types
UPDATE families f
SET familyType = (
    SELECT i.people_type
    FROM individuals i
    WHERE i.family_id = f.id
    GROUP BY i.people_type
    HAVING COUNT(DISTINCT i.people_type) = 1 
    AND i.people_type IN ('regular', 'local_visitor', 'traveller_visitor')
    LIMIT 1
)
WHERE f.id IN (
    SELECT DISTINCT family_id 
    FROM individuals 
    WHERE family_id IS NOT NULL
    GROUP BY family_id
    HAVING COUNT(DISTINCT people_type) = 1
);

-- ============================================================================
-- PART 3: UPDATE APPLICATION LOGIC COMPATIBILITY
-- ============================================================================

-- No changes needed to individuals table - people_type is already correct
-- ENUM('regular', 'local_visitor', 'traveller_visitor')

-- ============================================================================
-- VERIFICATION QUERIES (commented out)
-- ============================================================================

-- Uncomment these to verify the migration results:

-- SELECT 'Family Type Distribution' as report_name;
-- SELECT familyType, COUNT(*) as count FROM families GROUP BY familyType;

-- SELECT 'People Type Distribution' as report_name;  
-- SELECT people_type, COUNT(*) as count FROM individuals GROUP BY people_type;

-- SELECT 'Family vs Member Type Consistency' as report_name;
-- SELECT 
--     f.familyType as family_type,
--     i.people_type as member_type,
--     COUNT(*) as count
-- FROM families f
-- JOIN individuals i ON f.id = i.family_id
-- GROUP BY f.familyType, i.people_type
-- ORDER BY f.familyType, i.people_type;

-- SELECT 'Families with Mixed Member Types' as report_name;
-- SELECT 
--     f.id,
--     f.family_name,
--     f.familyType,
--     GROUP_CONCAT(DISTINCT i.people_type) as member_types
-- FROM families f
-- JOIN individuals i ON f.id = i.family_id
-- GROUP BY f.id, f.family_name, f.familyType
-- HAVING COUNT(DISTINCT i.people_type) > 1;
