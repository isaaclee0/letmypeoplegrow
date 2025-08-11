-- Migration 012: Add familyType column to families table for visitor system
-- This enables storing visitor families with familyType = 'visitor'

-- Add familyType column (will fail silently if already exists)
ALTER TABLE families ADD COLUMN familyType ENUM('regular', 'visitor') DEFAULT 'regular' AFTER family_name;

-- Add index for familyType (will fail silently if already exists)
CREATE INDEX idx_family_type ON families (familyType);

-- Add lastAttended column to families table (will fail silently if already exists)
ALTER TABLE families ADD COLUMN lastAttended DATE AFTER family_identifier; 