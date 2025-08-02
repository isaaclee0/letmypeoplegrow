-- Migration 007: Add data access control setting
-- This migration adds a setting to control whether external applications can access church data

-- Add data_access_enabled column to church_settings table
ALTER TABLE church_settings 
ADD COLUMN data_access_enabled BOOLEAN DEFAULT false AFTER onboarding_completed;

-- Add index for performance
ALTER TABLE church_settings 
ADD INDEX idx_data_access_enabled (data_access_enabled);

-- Update existing church settings to have data access disabled by default
UPDATE church_settings 
SET data_access_enabled = false 
WHERE data_access_enabled IS NULL; 