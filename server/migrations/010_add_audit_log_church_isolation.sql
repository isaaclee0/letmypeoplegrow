-- Migration 010: Add church isolation to audit_log table
-- This migration adds church_id column to audit_log table for proper church isolation

-- Add church_id to audit_log table
ALTER TABLE audit_log ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Create index for church_id for better query performance
CREATE INDEX idx_audit_log_church_id ON audit_log (church_id); 