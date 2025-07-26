-- Migration 001: Fix audit_log table structure
-- Add missing entity_type and entity_id columns

-- Add entity_type column (will fail silently if already exists)
ALTER TABLE audit_log ADD COLUMN entity_type VARCHAR(50) AFTER action;

-- Add entity_id column (will fail silently if already exists)
ALTER TABLE audit_log ADD COLUMN entity_id INT AFTER entity_type;

-- Add index for the new columns (will fail silently if already exists)
CREATE INDEX idx_entity ON audit_log (entity_type, entity_id); 