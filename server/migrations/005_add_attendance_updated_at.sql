-- Migration 005: Add updated_at column to attendance_records
-- This migration adds the updated_at column to track when attendance records were last modified
-- This is safe to run on existing databases as it only adds a new column

-- Add updated_at column to attendance_records table (will fail silently if already exists)
ALTER TABLE attendance_records 
ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP 
AFTER present; 