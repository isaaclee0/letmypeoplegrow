-- Migration script for user preferences table
-- This script adds support for storing user UI preferences and last viewed data

-- Create user_preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  preference_key VARCHAR(100) NOT NULL,
  preference_value JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_preference (user_id, preference_key),
  INDEX idx_user_id (user_id),
  INDEX idx_church_id (church_id),
  INDEX idx_preference_key (preference_key)
) ENGINE=InnoDB;

-- Add some initial preference keys that we'll use:
-- 'attendance_last_viewed' - {gatheringId: number, date: string, timestamp: number}
-- 'reports_last_viewed' - {selectedGatherings: number[], startDate: string, endDate: string, timestamp: number}
-- 'people_last_viewed' - {selectedGathering: number, searchTerm: string, timestamp: number}
