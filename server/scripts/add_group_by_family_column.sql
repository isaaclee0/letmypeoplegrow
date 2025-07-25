-- Migration script to add group_by_family column to gathering_types table
-- Run this if the column doesn't exist

USE church_attendance;

-- Add group_by_family column if it doesn't exist
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS group_by_family BOOLEAN DEFAULT true;

-- Update existing records to have the default value
UPDATE gathering_types 
SET group_by_family = true 
WHERE group_by_family IS NULL; 