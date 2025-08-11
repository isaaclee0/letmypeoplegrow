-- Migration 022: Create migration_executions table for advanced migration tracking
-- This migration adds a table to track detailed migration execution history

USE church_attendance;

-- Create migration_executions table
CREATE TABLE IF NOT EXISTS migration_executions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  execution_id VARCHAR(100) NOT NULL UNIQUE,
  plan_summary JSON,
  results JSON,
  duration_ms INT,
  backup_path VARCHAR(500),
  dry_run BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_execution_id (execution_id),
  INDEX idx_created_at (created_at),
  INDEX idx_dry_run (dry_run)
) ENGINE=InnoDB;

-- Add comment to explain the table purpose
ALTER TABLE migration_executions COMMENT = 'Tracks advanced migration system executions with detailed logging and rollback support';
