-- Migration 009: Add visitor family support
-- Add familyType and lastAttended columns to families table for visitor families

-- Add familyType column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN familyType VARCHAR(20) DEFAULT 'regular' AFTER family_identifier;

-- Add lastAttended column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN lastAttended DATE AFTER familyType;

-- Add index for familyType (will fail silently if already exists)
CREATE INDEX idx_families_family_type ON families(familyType);

-- Add index for lastAttended (will fail silently if already exists)
CREATE INDEX idx_families_last_attended ON families(lastAttended);

-- Update existing families to have 'regular' type
UPDATE families SET familyType = 'regular' WHERE familyType IS NULL; 