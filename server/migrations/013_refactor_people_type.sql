-- Migration 013: Refactor people type system
-- Replace is_visitor and is_regular_attendee with a single people_type enum

USE church_attendance;

-- Add the new people_type column
ALTER TABLE individuals 
ADD COLUMN people_type ENUM('regular', 'local_visitor', 'traveller_visitor') DEFAULT 'regular' AFTER last_name;

-- Migrate existing data
-- Set people_type based on current is_visitor and is_regular_attendee values
UPDATE individuals 
SET people_type = CASE 
    WHEN is_visitor = 1 THEN 'local_visitor'  -- Default visitors to local_visitor
    WHEN is_regular_attendee = 1 THEN 'regular'
    ELSE 'regular'  -- Default fallback
END;

-- Remove the old columns
ALTER TABLE individuals 
DROP COLUMN is_visitor,
DROP COLUMN is_regular_attendee;

-- Add index for the new column
ALTER TABLE individuals 
ADD INDEX idx_people_type (people_type);

-- Update the visitors table to reference individuals instead of storing names
-- First, add individual_id column to visitors table
ALTER TABLE visitors 
ADD COLUMN individual_id INT NULL AFTER id,
ADD FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
ADD INDEX idx_individual_id (individual_id);

-- Migrate visitor data to individuals table
-- This will create new individual records for visitors that don't exist in individuals
INSERT IGNORE INTO individuals (first_name, last_name, people_type, family_id, notes, is_active, created_at, updated_at)
SELECT 
    CASE 
        WHEN LOCATE(' ', v.name) > 0 THEN SUBSTRING(v.name, 1, LOCATE(' ', v.name) - 1)
        ELSE v.name
    END as first_name,
    CASE 
        WHEN LOCATE(' ', v.name) > 0 THEN SUBSTRING(v.name, LOCATE(' ', v.name) + 1)
        ELSE ''
    END as last_name,
    CASE 
        WHEN v.visitor_type = 'potential_regular' THEN 'local_visitor'
        ELSE 'traveller_visitor'
    END as people_type,
    NULL as family_id,
    v.notes,
    1 as is_active,
    v.created_at,
    v.updated_at
FROM visitors v
WHERE v.individual_id IS NULL;

-- Update visitors table to link to the newly created individuals
UPDATE visitors v
JOIN individuals i ON (
    CASE 
        WHEN LOCATE(' ', v.name) > 0 THEN SUBSTRING(v.name, 1, LOCATE(' ', v.name) - 1)
        ELSE v.name
    END = i.first_name
    AND
    CASE 
        WHEN LOCATE(' ', v.name) > 0 THEN SUBSTRING(v.name, LOCATE(' ', v.name) + 1)
        ELSE ''
    END = i.last_name
    AND i.people_type IN ('local_visitor', 'traveller_visitor')
)
SET v.individual_id = i.id
WHERE v.individual_id IS NULL;

-- Clean up duplicate individuals that might have been created during migration
-- Keep the one with the most recent activity and mark others as inactive
UPDATE individuals i1
JOIN (
    SELECT 
        first_name, 
        last_name, 
        people_type,
        MAX(updated_at) as max_updated_at
    FROM individuals 
    WHERE people_type IN ('local_visitor', 'traveller_visitor')
    GROUP BY first_name, last_name, people_type
    HAVING COUNT(*) > 1
) duplicates ON i1.first_name = duplicates.first_name 
    AND i1.last_name = duplicates.last_name 
    AND i1.people_type = duplicates.people_type
    AND i1.updated_at < duplicates.max_updated_at
SET i1.is_active = 0; 