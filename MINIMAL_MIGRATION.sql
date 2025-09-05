-- Minimal Database Migration - Run in phpMyAdmin SQL tab

-- Add missing columns to gathering_types
ALTER TABLE gathering_types 
ADD COLUMN IF NOT EXISTS attendance_type ENUM('standard', 'headcount') DEFAULT 'standard' AFTER frequency,
ADD COLUMN IF NOT EXISTS custom_schedule JSON DEFAULT NULL AFTER attendance_type,
ADD INDEX IF NOT EXISTS idx_attendance_type (attendance_type);

-- Add missing column to individuals
ALTER TABLE individuals 
ADD COLUMN IF NOT EXISTS is_visitor BOOLEAN DEFAULT false AFTER is_active,
ADD INDEX IF NOT EXISTS idx_is_visitor (is_visitor);

-- Create headcount_records table
CREATE TABLE IF NOT EXISTS headcount_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  headcount INT NOT NULL DEFAULT 0,
  updated_by INT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session_headcount (session_id),
  INDEX idx_church_id (church_id),
  INDEX idx_updated_by (updated_by)
) ENGINE=InnoDB;

-- Create visitor_config table
CREATE TABLE IF NOT EXISTS visitor_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(36) NOT NULL,
  local_visitor_service_limit INT NOT NULL DEFAULT 6,
  traveller_visitor_service_limit INT NOT NULL DEFAULT 2,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_church_config (church_id),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Insert default visitor config
INSERT IGNORE INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
SELECT DISTINCT church_id, 6, 2 FROM users WHERE church_id IS NOT NULL;
