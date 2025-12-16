-- Migration: Add Elvanto OAuth configuration to church_settings
-- This allows each church to configure their own Elvanto OAuth app credentials

-- Add columns (will fail silently if they already exist - that's okay)
ALTER TABLE church_settings
ADD COLUMN elvanto_client_id VARCHAR(255) DEFAULT NULL,
ADD COLUMN elvanto_client_secret VARCHAR(255) DEFAULT NULL,
ADD COLUMN elvanto_redirect_uri VARCHAR(500) DEFAULT NULL;

-- Add index for faster lookups (will fail silently if it already exists)
CREATE INDEX idx_elvanto_client_id ON church_settings(elvanto_client_id);

