-- Migration 006: Add church isolation and API keys for IMPORTRANGE
-- This migration adds church_id to all relevant tables and creates API key management

-- Add church_id to church_settings if not exists
ALTER TABLE church_settings 
ADD COLUMN IF NOT EXISTS church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id,
ADD UNIQUE KEY unique_church_id (church_id);

-- Add church_id to users table
ALTER TABLE users 
ADD COLUMN church_id VARCHAR(36) NOT NULL AFTER id,
ADD FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
ADD INDEX idx_church_id (church_id);

-- Add church_id to gathering_types table
ALTER TABLE gathering_types 
ADD COLUMN church_id VARCHAR(36) NOT NULL AFTER id,
ADD FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
ADD INDEX idx_church_id (church_id);

-- Add church_id to families table
ALTER TABLE families 
ADD COLUMN church_id VARCHAR(36) NOT NULL AFTER id,
ADD FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
ADD INDEX idx_church_id (church_id);

-- Add church_id to individuals table
ALTER TABLE individuals 
ADD COLUMN church_id VARCHAR(36) NOT NULL AFTER id,
ADD FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
ADD INDEX idx_church_id (church_id);

-- Add church_id to attendance_sessions table
ALTER TABLE attendance_sessions 
ADD COLUMN church_id VARCHAR(36) NOT NULL AFTER id,
ADD FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
ADD INDEX idx_church_id (church_id);

-- Create API keys table for IMPORTRANGE access
CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(36) NOT NULL,
  key_name VARCHAR(255) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  permissions JSON NOT NULL DEFAULT '["read_attendance", "read_reports"]',
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP NULL,
  last_used_at TIMESTAMP NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_api_key (api_key),
  INDEX idx_church_id (church_id),
  INDEX idx_active (is_active),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB;

-- Create API access logs table
CREATE TABLE IF NOT EXISTS api_access_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_key_id INT NOT NULL,
  church_id VARCHAR(36) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  response_status INT,
  response_time_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
  INDEX idx_api_key (api_key_id),
  INDEX idx_church_id (church_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- Update existing data to assign church_id to existing records
-- This assumes there's at least one church_settings record
UPDATE users u 
JOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)
SET u.church_id = cs.church_id 
WHERE u.church_id IS NULL OR u.church_id = '';

UPDATE gathering_types gt 
JOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)
SET gt.church_id = cs.church_id 
WHERE gt.church_id IS NULL OR gt.church_id = '';

UPDATE families f 
JOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)
SET f.church_id = cs.church_id 
WHERE f.church_id IS NULL OR f.church_id = '';

UPDATE individuals i 
JOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)
SET i.church_id = cs.church_id 
WHERE i.church_id IS NULL OR i.church_id = '';

UPDATE attendance_sessions as_table 
JOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)
SET as_table.church_id = cs.church_id 
WHERE as_table.church_id IS NULL OR as_table.church_id = ''; 