-- Migration 003: Enhance visitors table for better attendance tracking
-- Add session_id and improve visitor management

-- Add session_id column (will fail silently if already exists)
ALTER TABLE visitors ADD COLUMN session_id INT AFTER id;

-- Add foreign key for session_id (will fail silently if already exists)
ALTER TABLE visitors ADD CONSTRAINT fk_visitors_session 
FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE;

-- Add index for session_id (will fail silently if already exists)
CREATE INDEX idx_session ON visitors (session_id);

-- Add last_attended column to track when visitor last attended (will fail silently if already exists)
ALTER TABLE visitors ADD COLUMN last_attended DATE AFTER notes;

-- Add index for last_attended (will fail silently if already exists)
CREATE INDEX idx_last_attended ON visitors (last_attended); 