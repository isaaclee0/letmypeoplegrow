-- Migration 006: Add church isolation support
-- This migration adds church_id columns to all relevant tables

-- Add church_id to church_settings
ALTER TABLE church_settings ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Add church_id to users table
ALTER TABLE users ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Add church_id to gathering_types table
ALTER TABLE gathering_types ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Add church_id to families table
ALTER TABLE families ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Add church_id to individuals table
ALTER TABLE individuals ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

-- Add church_id to attendance_sessions table
ALTER TABLE attendance_sessions ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;

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
  INDEX idx_api_key (api_key_id),
  INDEX idx_church_id (church_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB; 