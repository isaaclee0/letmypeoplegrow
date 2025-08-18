-- Migration 007: Add visitor filtering configuration table
-- This allows churches to configure how long visitors stay in recent lists

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

-- Insert default configurations for existing churches
INSERT IGNORE INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
SELECT DISTINCT church_id, 6, 2 
FROM users 
WHERE church_id IS NOT NULL;
