-- Migration 002: Add visitor flag to individuals table
-- This helps identify people who were originally added as visitors

-- Add is_visitor column (will fail silently if already exists)
ALTER TABLE individuals ADD COLUMN is_visitor BOOLEAN DEFAULT false AFTER is_active;

-- Add index for is_visitor (will fail silently if already exists)
CREATE INDEX idx_is_visitor ON individuals (is_visitor); 